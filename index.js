// Import các thư viện cần thiết
const express = require("express");
const { google } = require("googleapis");
require("dotenv").config(); // Tải các biến môi trường từ file .env

// Lấy thông tin credentials từ biến môi trường
const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  REDIRECT_URI,
  // --- Thêm credentials cho TÀI KHOẢN DỊCH VỤ (Service Account) ---
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY, // Private key phải được format đúng cách
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

// Khởi động server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
