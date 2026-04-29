const state = {
  data: { rankings: [], signals: [], generated_at: null },
  view: "wallets",
  query: "",
};

const fmtMoney = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const fmtPercent = new Intl.NumberFormat("zh-CN", {
  style: "percent",
  maximumFractionDigits: 1,
});

function shortAddress(value) {
  if (!value) return "--";
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function formatTime(value) {
  if (!value) return "--";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

function renderSummary() {
  const rankings = state.data.rankings || [];
  const signals = state.data.signals || [];
  const topScore = rankings[0]?.score || 0;
  const topPnl = Math.max(0, ...rankings.map((row) => Number(row.realized_pnl || 0)));

  setText("walletCount", rankings.length);
  setText("signalCount", signals.length);
  setText("topScore", topScore.toFixed(2));
  setText("topPnl", fmtMoney.format(topPnl));
  setText("updatedAt", formatTime(state.data.generated_at));
  setText("runStatus", "自动运行正常");
}

function renderWallets() {
  const tbody = document.getElementById("walletRows");
  const query = state.query.trim().toLowerCase();
  const rows = (state.data.rankings || []).filter((row) => {
    return `${row.name} ${row.wallet}`.toLowerCase().includes(query);
  });

  tbody.innerHTML = rows
    .map((row, index) => {
      const openClass = Number(row.open_pnl || 0) >= 0 ? "positive" : "negative";
      return `
        <tr>
          <td>${index + 1}</td>
          <td>
            <div class="wallet">
              <strong>${row.name || shortAddress(row.wallet)}</strong>
              <code>${shortAddress(row.wallet)}</code>
            </div>
          </td>
          <td class="score">${Number(row.score || 0).toFixed(2)}</td>
          <td class="positive">${fmtMoney.format(row.realized_pnl || 0)}</td>
          <td>${fmtPercent.format(row.roi || 0)}</td>
          <td>${fmtPercent.format(row.win_rate || 0)}</td>
          <td>${row.closed_positions || 0}</td>
          <td>${fmtPercent.format(row.concentration || 0)}</td>
          <td class="${openClass}">${fmtMoney.format(row.open_pnl || 0)}</td>
        </tr>
      `;
    })
    .join("");

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty">没有符合当前搜索的钱包。</td></tr>`;
  }
}

function renderSignals() {
  const wrap = document.getElementById("signalCards");
  const signals = state.data.signals || [];
  if (!signals.length) {
    wrap.innerHTML = `<div class="empty">当前没有通过风控过滤的近期信号。</div>`;
    return;
  }

  wrap.innerHTML = signals
    .map((signal) => {
      return `
        <article class="signal-card">
          <h3>${signal.title || "未命名市场"}</h3>
          <dl>
            <div><dt>方向</dt><dd>${signal.side} ${signal.outcome}</dd></div>
            <div><dt>价格</dt><dd>${Number(signal.price || 0).toFixed(3)}</dd></div>
            <div><dt>原始金额</dt><dd>${fmtMoney.format(signal.cash || 0)}</dd></div>
            <div><dt>建议仓位</dt><dd>${fmtMoney.format(signal.suggested_cash || 0)}</dd></div>
            <div><dt>钱包评分</dt><dd>${Number(signal.wallet_score || 0).toFixed(2)}</dd></div>
            <div><dt>时间</dt><dd>${formatTime(signal.timestamp)}</dd></div>
          </dl>
          <p class="wallet"><code>${shortAddress(signal.wallet)}</code></p>
        </article>
      `;
    })
    .join("");
}

function switchView(view) {
  state.view = view;
  for (const item of document.querySelectorAll(".tab")) {
    item.classList.toggle("active", item.dataset.view === view);
  }
  document.getElementById("walletsView").classList.toggle("hidden", view !== "wallets");
  document.getElementById("signalsView").classList.toggle("hidden", view !== "signals");
  document.getElementById("rulesView").classList.toggle("hidden", view !== "rules");
}

async function loadData() {
  try {
    const response = await fetch(`./data/latest.json?ts=${Date.now()}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    renderSummary();
    renderWallets();
    renderSignals();
  } catch (error) {
    setText("runStatus", "暂无数据");
    document.getElementById("walletRows").innerHTML = `<tr><td colspan="9" class="empty">还没有生成数据，请先运行 GitHub Action 或本地分析脚本。</td></tr>`;
  }
}

document.getElementById("walletSearch").addEventListener("input", (event) => {
  state.query = event.target.value;
  renderWallets();
});

for (const button of document.querySelectorAll(".tab")) {
  button.addEventListener("click", () => switchView(button.dataset.view));
}

loadData();
