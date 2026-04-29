# Polymarket 钱包盈利系统

这是一个中文 Polymarket 钱包分析网页系统。它会筛选近期表现较好的钱包，生成钱包排名和近期信号，并通过 GitHub Pages 展示。

它不会自动下单，也不保证盈利。请先用于研究和纸面跟踪。

## 本地运行

```bash
python3 polymarket_profit_system.py analyze --config config.example.json
python3 polymarket_profit_system.py signals --config config.example.json
```

快速版本：

```bash
python3 polymarket_profit_system.py analyze --config config.lite.json
python3 polymarket_profit_system.py signals --config config.lite.json
```

输出文件：

- `wallet_rankings.csv`
- `wallet_rankings.json`
- `signals.csv`
- `signals.json`
- `docs/data/latest.json`

## 网页

网页入口在 `docs/index.html`。部署到 GitHub Pages 后，网页会读取 `docs/data/latest.json` 并显示中文看板。

## OKX 钱包跟单

网页包含 `OKX跟单` 页面：

- 连接 OKX Wallet 浏览器插件
- 自动检查并切换到 Polygon 网络
- 按最低钱包评分、最高价格、单笔金额上限生成待执行队列
- 打开对应 Polymarket 市场页
- 为后续接入 CLOB 下单保留 `asset/tokenId`

安全限制：当前版本不会在网页或 GitHub 中保存私钥，也不会绕过 OKX 钱包确认弹窗。GitHub Actions 可以自动更新信号，但不能代替你的 OKX 钱包无人值守签名。若要做完全无人值守交易，需要单独部署私有签名服务，并承担私钥托管风险。

## 自动运行

`.github/workflows/update-and-deploy.yml` 会：

1. 每 4 小时自动运行一次
2. 重新抓取 Polymarket 数据
3. 生成钱包排名和近期信号
4. 部署到 GitHub Pages

也可以在 GitHub Actions 页面手动点击 `Run workflow`。

## 方法

Polymarket 的 leaderboard 支持 `DAY`、`WEEK`、`MONTH`、`ALL`，但没有精确的 90 天窗口。本系统只用 leaderboard 建立候选池，然后从钱包级 positions、closed positions 和 trades 重新计算 90 天指标。

钱包评分综合：

- 90 天 realized PnL
- ROI
- 胜率
- 已结算样本数
- 交易市场数量
- 单一市场集中度
- 当前未平仓 PnL 风险

## 风控规则

- 先纸面运行至少 2 周
- 默认要求 90 天内至少 10-15 个已结算仓位
- 默认过滤低于 0.12 或高于 0.88 的价格
- 单笔建议仓位约为本金 1%
- 单市场最大敞口默认不超过 8%
- 多个强钱包同向时，信号质量更高
- 自动跟单也必须经过钱包确认，避免网页保管私钥
