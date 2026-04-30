const state = {
  data: { rankings: [], signals: [], manual_wallets: [], generated_at: null },
  view: "wallets",
  query: "",
  okx: {
    address: "",
    chainId: "",
  },
  copySettings: {
    enabled: false,
    maxCash: 50,
    minScore: 60,
    maxPrice: 0.88,
  },
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

function renderManualWallets() {
  const tbody = document.getElementById("manualRows");
  const rankingsByWallet = new Map((state.data.rankings || []).map((row) => [String(row.wallet).toLowerCase(), row]));
  const rows = state.data.manual_wallets || [];

  tbody.innerHTML = rows
    .map((row, index) => {
      const wallet = String(row.proxyWallet || row.wallet || "").toLowerCase();
      const analyzed = rankingsByWallet.get(wallet);
      const status = analyzed
        ? `已入选，评分 ${Number(analyzed.score || 0).toFixed(2)}`
        : "已加入候选，等待通过过滤或下次重算";
      return `
        <tr>
          <td>${index + 1}</td>
          <td><strong>${row.userName || row.name || "--"}</strong></td>
          <td><code>${wallet}</code></td>
          <td class="positive">${fmtMoney.format(row.pnl || 0)}</td>
          <td>${status}</td>
        </tr>
      `;
    })
    .join("");

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">还没有手动指定钱包。</td></tr>`;
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
            <div><dt>Token ID</dt><dd>${signal.asset ? shortAddress(String(signal.asset)) : "缺失"}</dd></div>
          </dl>
          <p class="wallet"><code>${shortAddress(signal.wallet)}</code></p>
        </article>
      `;
    })
    .join("");
}

function loadCopySettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("copySettings") || "{}");
    state.copySettings = { ...state.copySettings, ...saved };
  } catch (_) {
    localStorage.removeItem("copySettings");
  }

  document.getElementById("autoCopyEnabled").checked = state.copySettings.enabled;
  document.getElementById("maxCopyCash").value = state.copySettings.maxCash;
  document.getElementById("minCopyScore").value = state.copySettings.minScore;
  document.getElementById("maxCopyPrice").value = state.copySettings.maxPrice;
}

function saveCopySettings() {
  state.copySettings = {
    enabled: document.getElementById("autoCopyEnabled").checked,
    maxCash: Number(document.getElementById("maxCopyCash").value || 0),
    minScore: Number(document.getElementById("minCopyScore").value || 0),
    maxPrice: Number(document.getElementById("maxCopyPrice").value || 0),
  };
  localStorage.setItem("copySettings", JSON.stringify(state.copySettings));
  renderCopyQueue();
}

function getOkxProvider() {
  return window.okxwallet?.ethereum || window.okxwallet || null;
}

async function connectOkxWallet() {
  const provider = getOkxProvider();
  if (!provider?.request) {
    alert("未检测到 OKX 钱包插件。请安装并解锁 OKX Wallet 后刷新页面。");
    return;
  }

  const accounts = await provider.request({ method: "eth_requestAccounts" });
  state.okx.address = accounts?.[0] || "";
  state.okx.chainId = await provider.request({ method: "eth_chainId" });
  await ensurePolygon(provider);
  renderOkxState();
  renderCopyQueue();
}

async function ensurePolygon(provider) {
  const polygonChainId = "0x89";
  if (state.okx.chainId === polygonChainId) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: polygonChainId }],
    });
  } catch (error) {
    if (error?.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: polygonChainId,
            chainName: "Polygon",
            nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
            rpcUrls: ["https://polygon-rpc.com"],
            blockExplorerUrls: ["https://polygonscan.com"],
          },
        ],
      });
    } else {
      throw error;
    }
  }
  state.okx.chainId = await provider.request({ method: "eth_chainId" });
}

function renderOkxState() {
  const connected = Boolean(state.okx.address);
  setText("okxStatus", connected ? "已连接 Polygon" : "未连接");
  setText("okxAddress", connected ? state.okx.address : "--");
  document.getElementById("connectOkx").textContent = connected ? "重新连接" : "连接 OKX 钱包";
}

function eligibleCopySignals() {
  const settings = state.copySettings;
  return (state.data.signals || []).filter((signal) => {
    return (
      signal.side === "BUY" &&
      Number(signal.wallet_score || 0) >= settings.minScore &&
      Number(signal.price || 0) <= settings.maxPrice &&
      Number(signal.suggested_cash || 0) > 0
    );
  });
}

function polymarketUrl(signal) {
  return signal.slug ? `https://polymarket.com/event/${signal.slug}` : "https://polymarket.com";
}

function renderCopyQueue() {
  const wrap = document.getElementById("copyQueue");
  const queue = state.copySettings.enabled ? eligibleCopySignals() : [];
  setText("queueCount", `${queue.length} 条`);

  if (!state.copySettings.enabled) {
    wrap.innerHTML = `<div class="empty">开启自动跟单队列后，系统会把符合条件的信号放到这里。</div>`;
    return;
  }

  if (!queue.length) {
    wrap.innerHTML = `<div class="empty">当前没有符合 OKX 跟单设置的信号。</div>`;
    return;
  }

  wrap.innerHTML = queue
    .map((signal, index) => {
      const cappedCash = Math.min(Number(signal.suggested_cash || 0), state.copySettings.maxCash);
      const executable = Boolean(signal.asset);
      return `
        <article class="queue-item">
          <div>
            <h4>${signal.title || "未命名市场"}</h4>
            <p>${signal.outcome} @ ${Number(signal.price || 0).toFixed(3)} · 建议 ${fmtMoney.format(cappedCash)}</p>
            <code>${executable ? `asset ${shortAddress(String(signal.asset))}` : "缺少 tokenId，暂不可自动提交"}</code>
          </div>
          <div class="queue-actions">
            <a class="secondary-action link-action" href="${polymarketUrl(signal)}" target="_blank" rel="noreferrer">打开市场</a>
            <button class="primary-action" type="button" data-copy-index="${index}" ${executable ? "" : "disabled"}>准备下单</button>
          </div>
        </article>
      `;
    })
    .join("");

  for (const button of document.querySelectorAll("[data-copy-index]")) {
    button.addEventListener("click", () => prepareOrder(queue[Number(button.dataset.copyIndex)]));
  }
}

async function prepareOrder(signal) {
  if (!state.okx.address) {
    await connectOkxWallet();
  }
  const cappedCash = Math.min(Number(signal.suggested_cash || 0), state.copySettings.maxCash);
  const message = [
    "OKX 钱包已连接。",
    "当前版本会生成受风控约束的跟单订单草稿。",
    "",
    `市场：${signal.title}`,
    `方向：买入 ${signal.outcome}`,
    `价格：${Number(signal.price || 0).toFixed(3)}`,
    `金额：${fmtMoney.format(cappedCash)}`,
    "",
    "为避免把私钥或 CLOB API 密钥放进网页，真实提交订单需要接入 Polymarket CLOB 订单签名服务。现在将打开 Polymarket 市场页供你用 OKX 钱包确认交易。"
  ].join("\\n");
  alert(message);
  window.open(polymarketUrl(signal), "_blank", "noopener,noreferrer");
}

function switchView(view) {
  state.view = view;
  for (const item of document.querySelectorAll(".tab")) {
    item.classList.toggle("active", item.dataset.view === view);
  }
  document.getElementById("walletsView").classList.toggle("hidden", view !== "wallets");
  document.getElementById("watchlistView").classList.toggle("hidden", view !== "watchlist");
  document.getElementById("signalsView").classList.toggle("hidden", view !== "signals");
  document.getElementById("copyView").classList.toggle("hidden", view !== "copy");
  document.getElementById("rulesView").classList.toggle("hidden", view !== "rules");
}

async function loadData() {
  try {
    const response = await fetch(`./data/latest.json?ts=${Date.now()}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    renderSummary();
    renderWallets();
    renderManualWallets();
    renderSignals();
    renderCopyQueue();
  } catch (error) {
    setText("runStatus", "暂无数据");
    document.getElementById("walletRows").innerHTML = `<tr><td colspan="9" class="empty">还没有生成数据，请先运行 GitHub Action 或本地分析脚本。</td></tr>`;
  }
}

document.getElementById("walletSearch").addEventListener("input", (event) => {
  state.query = event.target.value;
  renderWallets();
});

document.getElementById("connectOkx").addEventListener("click", connectOkxWallet);
document.getElementById("saveCopySettings").addEventListener("click", saveCopySettings);
document.getElementById("autoCopyEnabled").addEventListener("change", saveCopySettings);

for (const button of document.querySelectorAll(".tab")) {
  button.addEventListener("click", () => switchView(button.dataset.view));
}

loadCopySettings();
renderOkxState();
loadData();
