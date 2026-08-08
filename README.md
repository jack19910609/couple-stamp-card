# 愛的集點卡 MVP

兩位使用者各自登入後，透過一次性六位配對碼加入同一個 Couple Space，共同建立卡片並以 Supabase Realtime 同步每一筆蓋章與復原事件。

## 已實作的核心流程

- Email／密碼註冊與登入，以及個人顯示名稱
- 24 小時有效、一次性使用的六位配對碼
- 兩人一組的 Couple Space 與 Row Level Security
- 共同卡：名稱、可蓋章行動、共同目標次數與獎勵
- 獨立且可追溯的蓋章事件：操作者、卡片、時間及留言
- 十分鐘內復原，保留原事件與復原時間
- Supabase Postgres Changes 即時同步
- 站內通知、Web Push 訂閱偏好與背景原生通知（需完成下方 Push 部署）
- optimistic UI、本機離線 outbox 與恢復網路後自動重送
- 以事件 UUID 保證重送冪等，不會產生重複章
- 已同步、同步中、離線待同步及同步失敗狀態

## 本機啟動

需求：Node.js 20 以上，以及一個 Supabase 專案。

```bash
npm install
Copy-Item .env.example .env.local
npm run dev
```

在 `.env.local` 填入 Supabase Dashboard「Connect」頁面提供的值：

```dotenv
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-or-anon-key
```

Publishable／anon key 可以放在前端；不要把 `service_role` key 放進 Vite 環境變數。

`VITE_VAPID_PUBLIC_KEY` 也是可公開的瀏覽器金鑰；VAPID 私鑰與 Push webhook 密鑰只能存放在 Supabase Edge Function Secrets，不能放進 GitHub Pages 或任何 `VITE_` 環境變數。

若要執行自動化後端驗收，再於本機 `.env.local` 加入 `SUPABASE_SECRET_KEY`。這把金鑰只供驗證程式建立與清除暫時測試帳號，絕對不要加上 `VITE_` 前綴或提交至版本控制。

## 建立資料庫

### 使用 Supabase CLI

連結專案後執行 migration：

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

### 使用 Dashboard

也可以把 [`supabase/migrations/202608050001_initial_mvp.sql`](supabase/migrations/202608050001_initial_mvp.sql) 的內容貼進 SQL Editor 執行一次。

Migration 會建立：

- `profiles`
- `couple_spaces`
- `couple_members`
- `pairing_invites`
- `cards`
- `stamp_events`
- 配對、蓋章及復原 RPC
- 所有 RLS policies
- `cards` 與 `stamp_events` 的 Realtime publication
- 僅供受信任伺服器端驗收使用的 `service_role` 權限（不會暴露給前端）

## 原生 Push 部署

原生 Push 由 `supabase/functions/send-push` 發送；資料庫只會將新站內通知非同步轉送給這個 Function，因此 Push 服務失敗時不會影響蓋章或留言。

1. 套用所有 migrations，包含 `202608050008_push_notifications.sql`。
2. 部署 `send-push` Edge Function，並套用 [`supabase/config.toml`](supabase/config.toml) 的 `verify_jwt = false` 設定。
3. 在 Supabase Edge Function Secrets 設定 [`supabase/functions/.env.example`](supabase/functions/.env.example) 所列的五個值。`VAPID_PRIVATE_KEY` 與 `PUSH_WEBHOOK_SECRET` 不可寫入 Git、前端或 SQL migration。
4. 在 Supabase Vault 用同一個 `PUSH_WEBHOOK_SECRET` 建立名為 `couple_stamp_push_hook_secret` 的 secret。Migration 在這個 Vault secret 尚未存在時會安全略過 Push 轉送。
5. 將相同的 `VAPID_PUBLIC_KEY` 填入 GitHub Pages 的 `VITE_VAPID_PUBLIC_KEY` 後重新部署前端。

通知預設不會在鎖定畫面顯示留言內容。使用者必須到設定頁主動啟用通知；已開啟的 App 由 Realtime 更新，不會再顯示重複的原生系統通知。

若 Auth 的「Confirm email」保持開啟，新使用者必須先點擊驗證信中的連結才能登入。測試階段也可以在 Supabase Dashboard 的 Auth 設定中關閉 email confirmation。

## 驗證

```bash
npm test
npm run build
npm run verify:supabase
```

`verify:supabase` 會自動驗證一次性與過期配對碼、雙方讀取共同卡、Realtime 新增／復原、離線事件冪等重送，以及非成員 RLS 隔離；結束後會清除它建立的帳號與 Couple Space。

### 雙裝置驗收

1. 以瀏覽器一般視窗註冊使用者 A，以無痕視窗或另一支手機註冊使用者 B。
2. A 建立配對碼，B 輸入後確認兩邊都進入同一個首頁。
3. A 建立共同卡，確認 B 不重新整理也能看到卡片。
4. A 蓋章並留言，確認 B 即時出現進度與事件紀錄。
5. A 在十分鐘內復原，確認 B 的進度回復且紀錄保留為已復原。
6. 在 A 的瀏覽器 DevTools 切換 Offline 後蓋章，確認顯示「離線、1 筆待同步」。恢復 Online 後確認只新增一筆事件。

## 資料與同步設計

卡片的進度不直接儲存。畫面會計算該卡所有 `undone_at is null` 的 `stamp_events`，所以每一章都有完整來源，也不會因兩台裝置同時寫入而互相覆蓋。

離線時，前端先產生事件 UUID 並加入 `localStorage` outbox。恢復網路後會依序呼叫 `create_stamp_event`；資料庫以事件 UUID 作為主鍵，因此同一個 request 即使重送，也只會回傳原本的事件。離線期間提出的復原也會保存提出時間，因此只要當時仍在十分鐘窗口內，就不會因稍後才恢復網路而被錯誤拒絕。RPC 同時鎖定卡片列並檢查目標數，避免競態條件造成超額蓋章。

RLS 的授權來源是 `couple_members`，使用者只可讀取自己所在 Couple Space 的卡片、成員與事件。邀請接受、蓋章與復原使用受限的 `security definer` RPC，並在函式內重新檢查登入者、空間成員資格與業務規則。

## GitHub Pages

推送至 `master` 會觸發 GitHub Actions，將 production build 發布到 GitHub Pages。Vite 在 GitHub Actions 中使用 `/couple-stamp-card/` base path；正式網站是 `https://jack19910609.github.io/couple-stamp-card/`。

`VITE_SUPABASE_URL` 與 Publishable Key 放在 `.env.production`，因為它們本來就必須存在於瀏覽器 bundle。`SUPABASE_SECRET_KEY` 只留在本機 `.env.local`，絕不可提交或加入 GitHub Actions。

### PWA 版本更新

已加到桌面的 App 會在啟動、回到前景與每小時檢查新版。新版下載完成後會顯示「新版已下載」提示；使用者選擇「立即更新」才會重新載入，因此不需要重新加到桌面。

若裝置離線或仍有蓋章、復原、留言、表情等待同步，更新按鈕會暫時停用，待資料安全送出後才可套用。Service Worker 只預快取本站的版本化 App Shell 與安裝資源；Supabase Auth、API、Realtime 與 Push 服務一律維持網路請求。
