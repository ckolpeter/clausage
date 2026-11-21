# Clausage 開源規劃

## 階段總覽

| 版本 | 目標 | 主要工作 |
|---|---|---|
| **v0.1** 本機驗證 | 在你的 Windows 上確認可用 | `npm start` 測登入、抓資料、通知、位置記憶 |
| **v0.2** 首次開源發佈 | GitHub 上能下載三平台安裝檔 | 建 repo、CI 綠燈、英文介面、截圖、發 v0.2.0 |
| **v0.3** 穩定性 | 讓陌生使用者也用得順 | 自動更新、介面變動時的錯誤提示、基本測試 |
| **v0.4** 正式發佈 | 沒有安全警告、可用套件管理器安裝 | 程式碼簽章、winget / Homebrew / AUR |
| 之後 | 加分功能 | 用量歷史圖、多帳號、Tauri 版（縮小檔案） |

---

## v0.1 本機驗證（✅ Windows 已完成）

- [ ] `npm install && npm start`，在小工具裡登入 claude.ai
- [ ] 確認 5 小時與每週數字和 claude.ai「設定 → 使用量」一致
- [ ] 測試：拖曳、重開後位置、雙擊精簡模式、系統匣、設定視窗、登出再登入
- [ ] `npm run dist:win`，確認安裝版與免安裝版能執行
- [ ] 錯誤訊息截圖給 Claude 修正

## v0.2 首次開源發佈

**建立 GitHub repo**
```powershell
cd $HOME\Desktop\clausage
git init -b main
git add .
git commit -m "Initial commit"
gh repo create clausage --public --source . --push   # 或在 github.com 建立後 git remote add + push
```
- [x] GitHub 帳號填入 `ckolpeter`（package.json、LICENSE、CONTRIBUTING.md）
- [ ] 決定授權（目前為 MIT）
- [ ] 第一次 `npm install` 後把 `package-lock.json` 一起 commit（CI 會改用較穩定的 `npm ci`）
- [ ] Settings → Security 開啟 *Private vulnerability reporting*
- [ ] 確認 Actions 三平台建置都通過（Mac 版會在 GitHub 的 macOS 機器上建，不需要你有 Mac）

- [x] **多國語言**：已支援 English / 繁體中文，依系統語言自動切換，也可手動選。新增語言只要在 `src/locales/` 加一個 JSON 檔（下一個建議：簡體中文 `zh-CN`、日文 `ja`）

**發佈**
```powershell
npm version 0.2.0
git push --follow-tags
```
Actions 會建立 Release 草稿並附上 `.exe` / `.dmg` / `.AppImage` / `.deb`，確認後按 Publish。

**曝光**：README 截圖或 GIF、repo topics（`claude` `anthropic` `electron` `widget`）、貼到 r/ClaudeAI、Hacker News「Show HN」。

## v0.3 穩定性

- [ ] **介面變動偵測**：回應格式不符時顯示「介面已變更，請更新 Clausage」並附 issue 連結
- [ ] 抓取失敗時指數退避，避免一直打 claude.ai
- [ ] 把 `normalize()` 拆成獨立模組，加單元測試（用範例 JSON）
- [ ] ESLint + Prettier，CI 加上 lint
- [ ] Linux：確認 GNOME（需要 AppIndicator 擴充）和 KDE 的系統匣行為

## v0.4 正式發佈（簽章與套件管理器）

| 平台 | 方案 | 成本 |
|---|---|---|
| macOS | Apple Developer Program（簽章 + 公證） | US$99 / 年 |
| Windows | [SignPath Foundation](https://signpath.org/)（開源專案免費）或 Azure Trusted Signing | 免費 / 約 US$10 / 月 |
| Linux | 不需要 | — |

取得憑證後，把它們加到 repo Secrets（`CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`），workflow 已預留好位置。

套件管理器：
- Windows：`winget`（送 PR 到 microsoft/winget-pkgs）
- macOS：Homebrew Cask（先放自己的 tap，熱門後再送官方）
- Linux：AUR、Flathub

## 已完成的功能（v0.2 前）

- [x] 用完時間預測、系統匣圖示顯示數字、額度重置通知、額外用量花費
- [x] 用量歷史圖（本機保存 8 天）
- [x] 自動更新（Windows 安裝版／Linux AppImage 自動下載；macOS 與免安裝版提示下載）
- [x] 全域快捷鍵、滑鼠穿透、亮色／跟隨系統主題、大小縮放
- [x] 多帳號
- [x] Claude Code 各模型 token 統計
- [x] 讀取新版 `limits` 陣列與 `seven_day_breakdown`
- [x] 10 種語言（en、zh-TW、zh-CN、ja、ko、es、fr、de、pt-BR、ru）
- [x] 離線偵測、斷線自動重試（15 秒起逐步拉長）、介面變更時一鍵回報
- [x] 自訂通知門檻、勿擾時段
- [x] 全螢幕自動隱藏（Windows）、貼齊螢幕邊緣
- [x] 用量紀錄匯出 CSV
- [x] 自動化測試：`npm test`（解析、預測、紀錄、翻譯檔，以及用模擬 Electron 跑完整流程），GitHub Actions 每次建置都會執行

## 之後的想法

- 本機記錄用量歷史，畫出每天的曲線
- 多帳號 / 多組織同時顯示
- 自訂通知門檻、勿擾時段
- 主題（亮色、跟隨系統）
- Tauri 版：安裝檔從約 100MB 降到約 10MB

---

## 風險與注意事項

1. **非公開介面**：Anthropic 隨時可能改掉 `/api/organizations/{org}/usage`。保持更新頻率保守（預設 120 秒），README 也要寫清楚。
2. **使用條款**：自動化存取 claude.ai 可能受服務條款限制。這是讀取自己帳號的資料、頻率很低，但要在 README 提醒使用者自行評估。
3. **商標**：名稱與圖示不使用 Anthropic 的 logo；README 已寫明「非官方」。
4. **憑證安全**：sessionKey 等同密碼。永遠不能寫進 log、不能送到第三方；issue 範本已提醒使用者不要貼。
