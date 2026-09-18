# 晉欣廠人時性儀表板

## 日常更新方式

1. 先在 GitHub Desktop 按 **Fetch origin / Pull origin**，取得最新自動轉檔結果。
2. 將新的晉欣廠生產日報 `.xlsx` 放到 `data/`（也支援其下的年月子資料夾）。
3. Commit 並 Push 到 `main` 或 `master`。
4. GitHub Actions 會自動掃描 Excel，更新 `data/manifest.json`、`data/json-manifest.json` 與 `data-json/`。
5. Actions 完成後，再 Pull 一次取得機器人產生的 JSON。

不需要手動修改任何 manifest。若同月份同日起始日同時存在部分檔與完整檔，例如 `01-18` 與 `01-31`，程式會自動採用結束日期較晚的完整版本，避免資料重複。

## 本機手動轉檔

需要 Node.js 20 以上版本：

```bash
npm ci
npm run convert:data
npm run check:data
```

網站會優先讀取精簡 JSON；若某份 JSON 尚未生成或讀取失敗，才會自動退回讀取原始 Excel。
