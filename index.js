// Import các thư viện cần thiết
const express = require("express");
const axios = require("axios");
const crypto = require("node:crypto");
const { google } = require("googleapis");
require("dotenv").config(); // Tải các biến môi trường từ file .env

// Lấy thông tin credentials từ biến môi trường
const {
  FB_APP_ID,
  FB_APP_SECRET,
  FB_REDIRECT_URI,
  FB_API_VERSION,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  REDIRECT_URI,
  ETSY_KEYSTRING,
  ETSY_REDIRECT_URI,
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY,
} = process.env;

// Khởi tạo ứng dụng web bằng Express
const app = express();
const PORT = process.env.PORT || 3000;

// Cache đơn giản trong bộ nhớ
const stateCache = new Map();

/**
 * Hàm trợ giúp để tạo một đối tượng OAuth2 client cho người dùng đăng nhập.
 */
function createLoginOAuth2Client() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

// === ROUTE 1: Bắt đầu luồng xác thực ===
// Client cần gửi kèm sheetId để server biết ghi token vào đâu
app.get("/auth", (req, res) => {
  const { sheetId } = req.query;

  if (!sheetId) {
    return res
      .status(400)
      .json({ error: "Missing required parameter: sheetId" });
  }

  const oauth2Client = createLoginOAuth2Client();

  // Tạo và lưu state token, kèm theo sheetId của người dùng
  const state = require("crypto").randomBytes(16).toString("hex");
  stateCache.set(state, { timestamp: Date.now(), sheetId: sheetId });
  console.log(`[AUTH] State created for sheetId '${sheetId}': ${state}`);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/adwords",
      "https://www.googleapis.com/auth/userinfo.email", // Vẫn cần để biết user là ai
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    state: state,
  });

  res.json({ auth_url: authUrl });
});

// === ROUTE 2: Xử lý callback từ Google ===
app.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  // Kiểm tra state token và lấy sheetId đã lưu
  const cachedData = stateCache.get(state);
  if (!cachedData) {
    return res
      .status(400)
      .send("⚠️ Invalid or expired state token. Please try again.");
  }
  const { sheetId } = cachedData;
  stateCache.delete(state); // Xóa state sau khi dùng

  try {
    const oauth2Client = createLoginOAuth2Client();

    // 1. Dùng 'code' để đổi lấy tokens của người dùng
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      return res
        .status(400)
        .send(
          "⚠️ Không nhận được Refresh Token. Hãy đảm bảo bạn đã đồng ý quyền truy cập offline."
        );
    }

    // 2. Dùng access token vừa nhận để lấy email của người dùng
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfoResponse = await oauth2.userinfo.get();
    const userEmail = userInfoResponse.data.email;

    console.log(`[CALLBACK] Tokens received for user '${userEmail}'.`);

    // 3. GHI refresh token vào sheet của người dùng bằng Service Account
    await writeTokenToSheetWithServiceAccount(sheetId, userEmail, refreshToken);

    res.send(
      `✅ Authorized successfully for ${userEmail}. Your refresh token has been written to the target Google Sheet. You can close this window.`
    );
  } catch (error) {
    console.error("Error during authentication:", error);
    res.status(500).send("Error during authentication: " + error.message);
  }
});

/**
 * Ghi token vào Google Sheet bằng tài khoản dịch vụ.
 * @param {string} spreadsheetId - ID của spreadsheet đích.
 * @param {string} userEmail - Email của người dùng đã đăng nhập.
 * @param {string} refreshToken - Refresh token để ghi.
 */
async function writeTokenToSheetWithServiceAccount(
  spreadsheetId,
  userEmail,
  refreshToken
) {
  try {
    // 1. Xác thực tài khoản dịch vụ
    const auth = new google.auth.JWT(
      GOOGLE_SERVICE_ACCOUNT_EMAIL,
      null,
      // Private key cần được format lại vì biến môi trường không nhận ký tự xuống dòng
      GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      ["https://www.googleapis.com/auth/spreadsheets"]
    );

    const sheets = google.sheets({ version: "v4", auth: auth });
    const sheetName = "gg_refresh_token";

    // 2. Lấy thông tin tất cả các sheet để kiểm tra
    const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId });
    const existingSheet = spreadsheetInfo.data.sheets.find(
      (s) => s.properties.title === sheetName
    );

    let sheetIdToHide = null;

    if (!existingSheet) {
      console.log(`[SHEETS] Sheet '${sheetName}' not found. Creating it...`);
      // 3a. Nếu sheet chưa tồn tại, tạo mới
      const addSheetResponse = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: { title: sheetName },
              },
            },
          ],
        },
      });
      const newSheetProperties =
        addSheetResponse.data.replies[0].addSheet.properties;
      sheetIdToHide = newSheetProperties.sheetId;
      console.log(`[SHEETS] Sheet created with ID: ${sheetIdToHide}`);

      // Thêm header vào sheet mới tạo
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "USER_ENTERED",
        resource: {
          values: [["Timestamp", "User Email", "Refresh Token"]],
        },
      });
    } else {
      sheetIdToHide = existingSheet.properties.sheetId;
    }

    // 4. Ghi dữ liệu token vào sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`, // Append sẽ tự tìm dòng trống tiếp theo
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[new Date().toISOString(), userEmail, refreshToken]],
      },
    });
    console.log(
      `[SHEETS] Successfully wrote token for '${userEmail}' to sheet '${sheetName}'.`
    );

    // 5. Ẩn sheet đi (nếu nó chưa bị ẩn)
    if (existingSheet ? !existingSheet.properties.hidden : true) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: {
                  sheetId: sheetIdToHide,
                  hidden: true,
                },
                fields: "hidden",
              },
            },
          ],
        },
      });
      console.log(`[SHEETS] Sheet '${sheetName}' is now hidden.`);
    }
  } catch (error) {
    console.error("[SHEETS] Failed to write to sheet:", error.message);
    // Ném lỗi ra để hàm callback có thể xử lý
    throw new Error(
      "Could not write token to the target Google Sheet. Please ensure the service account has Editor access."
    );
  }
}

// Cache lưu trạng thái phiên làm việc (Map: state -> {shopId, shopName, sheetId, codeVerifier})
const sessionCache = new Map();

// Các quyền truy cập Etsy (Scope) giống hệt code GAS cũ
const ETSY_SCOPES = "shops_r transactions_r billing_r email_r";

// ===============================================================
// SECTION: HELPER FUNCTIONS (PKCE & CRYPTO)
// ===============================================================

// Hàm mã hóa Base64 URL-safe (dùng cho PKCE)
const base64URLEncode = (str) => {
  return str
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};

// Hàm tạo mã Hash SHA256
const sha256 = (buffer) => {
  return crypto.createHash("sha256").update(buffer).digest();
};

// ===============================================================
// SECTION: ROUTE 1 - BẮT ĐẦU ĐĂNG NHẬP (/etsy/auth)
// ===============================================================
/**
 * Route này nhận các tham số từ client để bắt đầu luồng OAuth.
 * Query Params: ?shopId=...&shopName=...&sheetId=...
 */
app.get("/etsy/auth", (req, res) => {
  const { shopId, shopName, sheetId } = req.query;

  if (!shopId || !shopName || !sheetId) {
    return res
      .status(400)
      .send("Thiếu tham số: shopId, shopName, hoặc sheetId");
  }

  // 1. Tạo PKCE Code Verifier (Thay vì fix cứng như GAS, ta tạo động cho bảo mật)
  const codeVerifier = base64URLEncode(crypto.randomBytes(32));

  // 2. Tạo Code Challenge từ Verifier
  const codeChallenge = base64URLEncode(sha256(codeVerifier));

  // 3. Tạo State ngẫu nhiên để định danh phiên này
  const state = crypto.randomBytes(16).toString("hex");

  // 4. Lưu thông tin vào Cache để dùng lại ở bước Callback
  sessionCache.set(state, {
    shopId,
    shopName,
    sheetId,
    codeVerifier, // Cần lưu cái này để gửi lại cho Etsy ở bước đổi token
    timestamp: Date.now(),
  });

  // 5. Tạo URL chuyển hướng sang Etsy
  const authUrl = `https://www.etsy.com/oauth/connect?response_type=code&redirect_uri=${encodeURIComponent(
    ETSY_REDIRECT_URI
  )}&scope=${encodeURIComponent(
    ETSY_SCOPES
  )}&client_id=${ETSY_KEYSTRING}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

  // Trả về JSON chứa URL để frontend tự redirect
  res.json({ auth_url: authUrl });
});

// ===============================================================
// SECTION: ROUTE 2 - XỬ LÝ CALLBACK (/etsy/callback)
// ===============================================================
app.get("/etsy/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`Etsy trả về lỗi: ${error}`);
  }

  if (!code || !state) {
    return res.status(400).send("Thiếu thông tin 'code' hoặc 'state' từ Etsy.");
  }

  // 1. Kiểm tra State trong Cache
  const sessionData = sessionCache.get(state);
  if (!sessionData) {
    return res.status(400).send("State không hợp lệ hoặc phiên đã hết hạn.");
  }

  const { shopId, shopName, sheetId, codeVerifier } = sessionData;
  sessionCache.delete(state); // Xóa cache sau khi dùng

  try {
    // 2. Trao đổi Code lấy Token (POST request)
    const tokenUrl = "https://api.etsy.com/v3/public/oauth/token";
    const payload = {
      grant_type: "authorization_code",
      client_id: ETSY_KEYSTRING,
      redirect_uri: ETSY_REDIRECT_URI,
      code: code,
      code_verifier: codeVerifier, // Gửi lại verifier đã tạo lúc đầu
    };

    const response = await axios.post(tokenUrl, payload, {
      headers: { "Content-Type": "application/json" },
    });

    const tokenData = response.data;
    /* tokenData trả về:
       { access_token, refresh_token, expires_in, token_type, ... }
    */

    console.log(
      `[ETSY] Đã lấy token thành công cho Shop: ${shopName} (${shopId})`
    );

    // 3. Lưu Token vào Google Sheet bằng Service Account
    await writeEtsyTokenToSheet(sheetId, shopId, shopName, tokenData);

    res.send(`
      <style>body { font-family: sans-serif; text-align: center; padding-top: 50px; }</style>
      <h2>✅ Kết nối Etsy thành công!</h2>
      <p>Đã lưu token cho shop: <b>${shopName}</b> (ID: ${shopId}) vào file Google Sheet.</p>
      <p>Bạn có thể tắt cửa sổ này.</p>
      <script>setTimeout(() => window.close(), 5000);</script>
    `);
  } catch (err) {
    console.error(
      "[ETSY ERROR]",
      err.response ? err.response.data : err.message
    );
    res.status(500).send("Lỗi khi trao đổi token với Etsy: " + err.message);
  }
});

// ===============================================================
// SECTION: GOOGLE SHEETS SERVICE
// ===============================================================

/**
 * Hàm ghi token Etsy vào Google Sheet
 * Cấu trúc cột giống hệt file GAS cũ:
 * Col A: Shop ID | Col B: Name | Col C: Access Token | Col D: Refresh Token | Col E: Expires In | Col F: Created At
 */
async function writeEtsyTokenToSheet(
  spreadsheetId,
  shopId,
  shopName,
  tokenData
) {
  try {
    // 1. Xác thực Service Account
    const auth = new google.auth.JWT(
      GOOGLE_SERVICE_ACCOUNT_EMAIL,
      null,
      GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      ["https://www.googleapis.com/auth/spreadsheets"]
    );

    const sheets = google.sheets({ version: "v4", auth });
    const sheetName = "Etsy_Tokens"; // Tên sheet cố định theo code cũ

    // 2. Kiểm tra sheet tồn tại chưa, nếu chưa thì tạo và thêm Header
    const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId });
    let targetSheet = spreadsheetInfo.data.sheets.find(
      (s) => s.properties.title === sheetName
    );

    if (!targetSheet) {
      console.log(`[SHEETS] Sheet '${sheetName}' chưa có, đang tạo mới...`);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: sheetName } } }],
        },
      });

      // Thêm Header (Đúng thứ tự code cũ)
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [
            [
              "Shop ID",
              "Name",
              "Access Token",
              "Refresh Token",
              "Expires In",
              "Created At Timestamp",
            ],
          ],
        },
      });
    }

    // 3. Lấy dữ liệu hiện tại để kiểm tra xem Shop ID đã tồn tại chưa (để update hay append)
    // Lưu ý: Đọc cột A (Shop ID) và D (Refresh Token cũ)
    const readResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:D`, // Đọc đủ rộng để lấy thông tin cần thiết
    });

    const rows = readResponse.data.values || [];
    let rowIndexToUpdate = -1;
    let oldRefreshToken = "";

    // Tìm dòng chứa Shop ID (bỏ qua dòng header index 0)
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] && rows[i][0].toString() === shopId.toString()) {
        rowIndexToUpdate = i + 1; // +1 vì mảng bắt đầu từ 0, sheet bắt đầu từ 1
        oldRefreshToken = rows[i][3]; // Cột D là index 3
        break;
      }
    }

    // Chuẩn bị dữ liệu ghi
    const now = new Date().getTime();
    const finalRefreshToken = tokenData.refresh_token || oldRefreshToken; // Giữ lại token cũ nếu API không trả về cái mới

    const rowData = [
      shopId,
      shopName,
      tokenData.access_token,
      finalRefreshToken,
      tokenData.expires_in,
      now,
    ];

    if (rowIndexToUpdate > -1) {
      // UPDATE: Ghi đè vào dòng cũ
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A${rowIndexToUpdate}:F${rowIndexToUpdate}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [rowData] },
      });
      console.log(`[SHEETS] Đã cập nhật token cho Shop ID: ${shopId}`);
    } else {
      // APPEND: Thêm dòng mới
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [rowData] },
      });
      console.log(`[SHEETS] Đã thêm mới token cho Shop ID: ${shopId}`);
    }

    // Tùy chọn: Format cột A thành text để tránh lỗi hiển thị số lớn
    // (Phần này code Node.js hơi phức tạp nên tôi lược giản, Service Account ghi vào thường nó tự hiểu)
  } catch (error) {
    console.error(
      "[SHEETS ERROR] Không thể ghi vào Google Sheet:",
      error.message
    );
    throw new Error("Lỗi ghi Sheet: " + error.message);
  }
}

// Cache lưu trạng thái phiên (State -> {sheetId, timestamp})
const fbSessionCache = new Map();

// Các quyền (Scope) cần thiết
const FB_SCOPES = [
  "public_profile",
  "business_management",
  "ads_management",
  "ads_read",
  "pages_read_engagement",
  "pages_show_list",
  "read_insights",
].join(",");

// ===============================================================
// ROUTE 1: Bắt đầu đăng nhập Facebook (/facebook/auth)
// ===============================================================
app.get("/facebook/auth", (req, res) => {
  const { sheetId } = req.query;

  if (!sheetId) {
    return res.status(400).send("Thiếu tham số: sheetId");
  }

  // 1. Tạo State ngẫu nhiên để bảo mật và lưu sheetId
  const state = crypto.randomBytes(16).toString("hex");
  fbSessionCache.set(state, { sheetId, timestamp: Date.now() });

  // 2. Tạo URL đăng nhập Facebook
  const loginUrl = `https://www.facebook.com/${FB_API_VERSION}/dialog/oauth?client_id=${FB_APP_ID}&redirect_uri=${encodeURIComponent(
    FB_REDIRECT_URI
  )}&scope=${FB_SCOPES}&state=${state}&response_type=code`;

  res.json({ auth_url: loginUrl });
});

// ===============================================================
// ROUTE 2: Xử lý Callback từ Facebook (/facebook/callback)
// ===============================================================
app.get("/facebook/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`Facebook Error: ${error}`);
  }

  // 1. Kiểm tra State
  const sessionData = fbSessionCache.get(state);
  if (!sessionData) {
    return res.status(400).send("State không hợp lệ hoặc phiên đã hết hạn.");
  }
  const { sheetId } = sessionData;
  fbSessionCache.delete(state); // Xóa cache

  try {
    // 2. Đổi Code lấy Short-Lived Access Token (1-2 giờ)
    const tokenUrl = `https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`;
    const shortTokenRes = await axios.get(tokenUrl, {
      params: {
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        redirect_uri: FB_REDIRECT_URI,
        code: code,
      },
    });

    const shortAccessToken = shortTokenRes.data.access_token;

    // 3. [QUAN TRỌNG] Đổi Short-Lived Token lấy Long-Lived Token (60 ngày)
    // Bước này giúp hệ thống của bạn chạy ổn định mà không bắt user login lại
    const longTokenUrl = `https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`;
    const longTokenRes = await axios.get(longTokenUrl, {
      params: {
        grant_type: "fb_exchange_token",
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        fb_exchange_token: shortAccessToken,
      },
    });

    const longAccessToken = longTokenRes.data.access_token;
    const expiresInSeconds = longTokenRes.data.expires_in; // Thường là ~5184000 (60 ngày)

    // 4. Lấy thông tin User (Tên + ID) để lưu
    const userUrl = `https://graph.facebook.com/${FB_API_VERSION}/me?fields=id,name&access_token=${longAccessToken}`;
    const userRes = await axios.get(userUrl);
    const { id: userId, name: userName } = userRes.data;

    console.log(
      `[FACEBOOK] Đã lấy Long-Lived Token cho: ${userName} (${userId})`
    );

    // 5. Ghi vào Google Sheet
    await writeFacebookTokenToSheet(
      sheetId,
      userId,
      userName,
      longAccessToken,
      expiresInSeconds
    );

    res.send(`
      <style>body{font-family:sans-serif;text-align:center;padding-top:50px}</style>
      <h2>✅ Kết nối Facebook thành công!</h2>
      <p>Tài khoản: <b>${userName}</b> (ID: ${userId})</p>
      <p>Token dài hạn (60 ngày) đã được lưu vào Google Sheet.</p>
      <script>setTimeout(()=>window.close(), 5000)</script>
    `);
  } catch (err) {
    console.error("[FB ERROR]", err.response ? err.response.data : err.message);
    res.status(500).send("Lỗi xác thực Facebook: " + err.message);
  }
});

// ===============================================================
// HELPER: Ghi Token vào Google Sheet
// ===============================================================
async function writeFacebookTokenToSheet(
  spreadsheetId,
  userId,
  userName,
  token,
  expiresIn
) {
  try {
    // Auth Service Account
    const auth = new google.auth.JWT(
      GOOGLE_SERVICE_ACCOUNT_EMAIL,
      null,
      GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      ["https://www.googleapis.com/auth/spreadsheets"]
    );
    const sheets = google.sheets({ version: "v4", auth });
    const sheetName = "Facebook_Tokens";

    // Kiểm tra/Tạo Sheet
    const ssInfo = await sheets.spreadsheets.get({ spreadsheetId });
    let targetSheet = ssInfo.data.sheets.find(
      (s) => s.properties.title === sheetName
    );

    if (!targetSheet) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: sheetName } } }],
        },
      });
      // Tạo Header
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [
            [
              "User ID",
              "Name",
              "Access Token (Long-Lived)",
              "Expires In (Seconds)",
              "Updated At",
            ],
          ],
        },
      });
    }

    // Kiểm tra xem User ID đã tồn tại chưa để Update hay Append
    const readRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:A`,
    });

    const rows = readRes.data.values || [];
    let rowIndex = -1;

    // Tìm dòng chứa User ID (bỏ qua header)
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] == userId) {
        rowIndex = i + 1;
        break;
      }
    }

    const rowData = [
      userId,
      userName,
      token,
      expiresIn,
      new Date().toISOString(),
    ];

    if (rowIndex > -1) {
      // Update
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A${rowIndex}:E${rowIndex}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [rowData] },
      });
    } else {
      // Append
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [rowData] },
      });
    }
  } catch (error) {
    throw new Error("Lỗi ghi Sheet: " + error.message);
  }
}

// Khởi động server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
