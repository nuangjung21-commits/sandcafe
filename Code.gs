/**
 * 샌드카페 사장님 비서 - Google Apps Script (Code.gs)
 *
 * [스크립트 속성 설정 방법]
 * Apps Script 왼쪽 메뉴 [프로젝트 설정(톱니바퀴)] -> [스크립트 속성]
 * - 속성: GEMINI_API_KEY / 값: 발급받은 Gemini API 키
 * - (선택) 속성: ALLOWED_EMAILS / 값: 사장님구글이메일@gmail.com (여러 개면 쉼표로 구분)
 */

const SHEET_NAME = '매출';
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_OWNER_EMAIL = 'nuangjung21@gmail.com';
const HEADERS = ['저장시각', '날짜', '구분', '인원', '금액', '결제수단', '유입경로', '메모'];

const MENU_CATEGORIES = [
  '불고기샌드버거',
  '매콤닭고기샌드버거',
  '영양주먹밥',
  '단호박스퍼',
  '커피',
  '음료수',
  '기타'
];

const PAYMENT_METHODS = ['카드', '현금', '계좌이체', '네이버페이', '기타'];
const INFLOW_CHANNELS = ['인스타그램', '네이버 블로그', '네이버 지도', '지인 소개', '재방문', '지나가다', '기타'];

/**
 * 웹 앱 직접 접속 또는 상태 확인용 (GET)
 */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'status';
  if (action === 'status') {
    return jsonResponse_({
      ok: true,
      message: '샌드카페 사장님 비서 웹 앱이 정상 작동 중입니다.',
      sheetName: SHEET_NAME,
      model: GEMINI_MODEL
    });
  }
  return jsonResponse_({ ok: false, error: '알 수 없는 요청입니다.' });
}

/**
 * 외부 index.html (Vercel 등)에서 보내는 요청 처리 (POST)
 * CORS 사전 요청(Preflight) 문제를 피하기 위해 text/plain JSON 바디를 파싱합니다.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({ ok: false, error: '요청 데이터가 비어 있습니다.' });
    }

    const body = JSON.parse(e.postData.contents);
    const action = body.action || '';

    // Google 로그인 토큰 검증 (설정된 경우)
    const authResult = verifyGoogleAuth_(body.idToken);
    if (!authResult.ok) {
      return jsonResponse_({ ok: false, error: authResult.error, needAuth: true });
    }

    if (action === 'parse') {
      const text = (body.text || '').trim();
      if (!text) {
        return jsonResponse_({ ok: false, error: '말씀하신 내용(텍스트)이 비어 있습니다.' });
      }
      const parsed = parseWithGemini_(text, body.today);
      return jsonResponse_({ ok: true, data: parsed, userEmail: authResult.email });
    }

    if (action === 'save') {
      const rows = body.rows;
      if (!Array.isArray(rows) || rows.length === 0) {
        return jsonResponse_({ ok: false, error: '저장할 내역이 없습니다.' });
      }
      const result = saveRowsToSheet_(rows);
      return jsonResponse_({ ok: true, savedCount: result.savedCount, userEmail: authResult.email });
    }

    return jsonResponse_({ ok: false, error: '지원하지 않는 action입니다: ' + action });
  } catch (err) {
    return jsonResponse_({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
}

/**
 * Google ID 토큰 검증 및 허용된 사장님 이메일 확인
 * 스크립트 속성 ALLOWED_EMAILS가 비어 있으면 토큰이 있을 때만 이메일을 읽고 통과시킵니다.
 */
function verifyGoogleAuth_(idToken) {
  const props = PropertiesService.getScriptProperties();
  const allowedRaw = (props.getProperty('ALLOWED_EMAILS') || DEFAULT_OWNER_EMAIL).trim();
  const allowedEmails = allowedRaw
    ? allowedRaw.split(',').map(function(s) { return s.trim().toLowerCase(); }).filter(Boolean)
    : [];

  // 토큰이 아직 없을 때도 초기 테스트가 막히지 않도록 허용하되, 토큰이 있으면 사장님 계정인지 엄격히 확인
  if (!idToken) {
    return { ok: true, email: '' };
  }

  // Google tokeninfo 엔드포인트로 ID 토큰 검증
  const url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken);
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    return { ok: false, error: 'Google 로그인 인증이 만료되었거나 올바르지 않습니다. 다시 로그인해 주세요.' };
  }

  const info = JSON.parse(res.getContentText());
  const email = (info.email || '').toLowerCase();

  if (allowedEmails.length > 0 && allowedEmails.indexOf(email) === -1) {
    return {
      ok: false,
      error: '허용되지 않은 Google 계정입니다 (' + email + '). 사장님 계정으로 로그인해 주세요.'
    };
  }

  return { ok: true, email: email };
}

/**
 * Gemini API를 호출하여 사장님이 말한 원문을 구조화된 매출 데이터로 변환
 */
function parseWithGemini_(rawText, clientToday) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('Apps Script 스크립트 속성에 GEMINI_API_KEY가 설정되어 있지 않습니다.');
  }

  const todayStr = clientToday || Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');

  const prompt = [
    '당신은 "샌드카페" 사장님의 매출 장부 정리를 돕는 AI 비서입니다.',
    '사장님이 말한 매출 메모를 분석해서 아래 JSON 형식으로만 응답하세요.',
    '',
    '[기준 정보]',
    '- 오늘 날짜: ' + todayStr + ' (말한 내용에 "어제", "그저께", 특정 날짜가 없으면 오늘 날짜 사용)',
    '- 허용 구분(메뉴) 목록: ' + MENU_CATEGORIES.join(', '),
    '  (참고: "샌드버거"라고만 말하면 문맥상 구분에 표기하거나 기타/샌드버거로 매칭, "단호박스프"나 "단호박스퍼"는 "단호박스퍼"로 매칭)',
    '- 허용 결제수단 목록: ' + PAYMENT_METHODS.join(', ') + ' (언급 없으면 "카드")',
    '- 허용 유입경로 목록: ' + INFLOW_CHANNELS.join(', ') + ' (언급 없으면 "기타")',
    '',
    '[출력 JSON 스키마]',
    '{',
    '  "combined": {',
    '    "날짜": "YYYY-MM-DD",',
    '    "구분": "메뉴 요약 (예: 불고기샌드버거 20개, 영양주먹밥 10개)",',
    '    "인원": "인원 또는 총 수량 숫자만 (예: 30)",',
    '    "금액": 숫자만(원 단위 정수, 예: 30만원 -> 300000),',
    '    "결제수단": "카드 | 현금 | 계좌이체 | 네이버페이 | 기타 중 하나",',
    '    "유입경로": "인스타그램 | 네이버 블로그 | 네이버 지도 | 지인 소개 | 재방문 | 지나가다 | 기타 중 하나",',
    '    "메모": "사장님이 말한 원문 그대로"',
    '  },',
    '  "items": [',
    '    {',
    '      "날짜": "YYYY-MM-DD",',
    '      "구분": "불고기샌드버거 | 매콤닭고기샌드버거 | 영양주먹밥 | 단호박스퍼 | 커피 | 음료수 | 기타 중 가장 가까운 것",',
    '      "인원": "해당 메뉴 수량 또는 인원 숫자",',
    '      "금액": 해당 메뉴 금액 숫자(총액만 말한 경우 첫 항목에 총액을 넣거나 아는 범위로 배분),',
    '      "결제수단": "카드 | 현금 | 계좌이체 | 네이버페이 | 기타 중 하나",',
    '      "유입경로": "인스타그램 | 네이버 블로그 | 네이버 지도 | 지인 소개 | 재방문 | 지나가다 | 기타 중 하나",',
    '      "메모": "사장님이 말한 원문 그대로"',
    '    }',
    '  ]',
    '}',
    '',
    '[사장님이 말한 원문]',
    rawText
  ].join('\n');

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(GEMINI_MODEL) +
    ':generateContent?key=' +
    encodeURIComponent(apiKey);

  const payload = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const resText = response.getContentText();

  if (status !== 200) {
    throw new Error('Gemini API 호출 실패 (' + status + '): ' + resText);
  }

  const resJson = JSON.parse(resText);
  const candidateText =
    resJson &&
    resJson.candidates &&
    resJson.candidates[0] &&
    resJson.candidates[0].content &&
    resJson.candidates[0].content.parts &&
    resJson.candidates[0].content.parts[0] &&
    resJson.candidates[0].content.parts[0].text;

  if (!candidateText) {
    throw new Error('Gemini 응답에서 결과를 읽지 못했습니다.');
  }

  const cleaned = candidateText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = JSON.parse(cleaned);

  // 기본값 보정
  const fallbackRow = {
    날짜: todayStr,
    구분: '기타',
    인원: '',
    금액: 0,
    결제수단: '카드',
    유입경로: '기타',
    메모: rawText
  };

  const combined = Object.assign({}, fallbackRow, parsed.combined || {});
  combined.메모 = rawText;

  const items = Array.isArray(parsed.items) && parsed.items.length > 0
    ? parsed.items.map(function(item) {
        const row = Object.assign({}, fallbackRow, item || {});
        row.메모 = rawText;
        return row;
      })
    : [combined];

  return {
    combined: combined,
    items: items
  };
}

/**
 * 구글 시트 '매출' 탭에 행 추가
 * 열 순서: 저장시각 · 날짜 · 구분 · 인원 · 금액 · 결제수단 · 유입경로 · 메모
 */
function saveRowsToSheet_(rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);

  // '매출' 탭이 없으면 자동 생성
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  // 첫 줄 헤더가 비어 있으면 자동 생성
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#f3f4f6');
  }

  const nowStr = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');

  rows.forEach(function(row) {
    const amountNum = Number(String(row['금액'] || '0').replace(/[^0-9.-]/g, '')) || 0;
    sheet.appendRow([
      nowStr,
      row['날짜'] || Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'),
      row['구분'] || '기타',
      row['인원'] !== undefined && row['인원'] !== null ? String(row['인원']) : '',
      amountNum,
      row['결제수단'] || '카드',
      row['유입경로'] || '기타',
      row['메모'] || ''
    ]);
  });

  return { savedCount: rows.length };
}

/**
 * JSON 응답 헬퍼
 */
function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
