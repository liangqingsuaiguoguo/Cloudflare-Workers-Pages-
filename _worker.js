/**
 * Cloudflare Workers & Pages 专业多账号监控中心 (CF Monitor Pro V3.0)
 * 核心架构: Single-File Worker + D1 + Telegram
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    await initDatabase(env.DB);

    if (request.method === "OPTIONS") return corsResponse({}, 200);
    if (path === "/api/login") return handleLogin(request, env);

    // 鉴权中间件 (只读查询接口放行，保障安全的同时支持在公共设备作为大盘展示)
    if (path.startsWith("/api/")) {
      const publicPaths = ["/api/usage", "/api/trend", "/api/system", "/api/cron-log"];
      if (!publicPaths.includes(path)) {
        if (!(await checkAuth(request, env))) {
          return corsResponse({ success: false, message: "未授权或密码验证已过期，请重新登录" }, 401);
        }
      }
    }

    // 接口路由定义
    if (path === "/api/config") return handleConfig(request, env);
    else if (path.startsWith("/api/config/account/")) return handleDeleteAccount(request, env, path);
    else if (path === "/api/refresh") return handleManualRefresh(request, env, ctx);
    else if (path === "/api/test-telegram") return handleTestTelegram(request, env);
    else if (path === "/api/push-brag") return handlePushBrag(request, env);
    
    // 数据查询 API
    else if (path === "/api" || path === "/api/usage") return handleUsage(request, env);
    else if (path === "/api/system") return handleSystemState(request, env);
    else if (path === "/api/trend") return handleTrend(request, env);
    else if (path === "/api/cron-log") return handleCronLog(request, env);

    // 默认 Web UI
    return serveDashboardHTML(request, env);
  },

  async scheduled(event, env, ctx) {
    await initDatabase(env.DB);
    await runMonitoringTask(env, ctx);
  }
};

// =======================
// 1. 数据库持久化与平滑迁移
// =======================
async function initDatabase(db) {
  if (!db) throw new Error("未绑定 D1 数据库");
  
  await db.prepare("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, accountId TEXT NOT NULL, apiToken TEXT NOT NULL, customLimit INTEGER DEFAULT 100000, active INTEGER DEFAULT 1, lastChecked INTEGER)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, accountName TEXT NOT NULL, timestamp INTEGER NOT NULL, workersRequests INTEGER NOT NULL, pagesRequests INTEGER NOT NULL, totalRequests INTEGER NOT NULL, limitRequests INTEGER NOT NULL, cpuTime REAL DEFAULT 0, kvReads INTEGER DEFAULT 0, kvWrites INTEGER DEFAULT 0, cronStatus TEXT DEFAULT 'success', apiStatus TEXT DEFAULT 'success')").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS alerts_log (accountId TEXT, threshold TEXT, date TEXT, timestamp INTEGER, PRIMARY KEY(accountId, threshold, date))").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS cron_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, status TEXT, message TEXT, totalRequests INTEGER, executionTimeMs INTEGER)").run();

  try { await db.prepare("ALTER TABLE accounts ADD COLUMN groupName TEXT DEFAULT 'Default'").run(); } catch(e){}
  try { await db.prepare("ALTER TABLE accounts ADD COLUMN remark TEXT DEFAULT ''").run(); } catch(e){}

  const hasPassword = await db.prepare("SELECT * FROM config WHERE key = 'admin_password'").first();
  if (!hasPassword) {
    await db.prepare("INSERT INTO config (key, value) VALUES ('admin_password', 'admin')").run();
    await db.prepare("INSERT INTO config (key, value) VALUES ('cron_config', '{\"frequency\": 10}')").run();
    await db.prepare("INSERT INTO config (key, value) VALUES ('telegram_config', '{\"enabled\": false, \"botToken\": \"\", \"chatId\": \"\", \"dailyReportTime\": \"08:00\", \"alertThreshold\": 90, \"surgeAlertEnabled\": false}')").run();
  }
}

// =======================
// 2. 鉴权与全局配置路由
// =======================
async function checkAuth(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;
  const pwdRecord = await env.DB.prepare("SELECT value FROM config WHERE key = 'admin_password'").first();
  return authHeader === "Bearer " + (pwdRecord ? pwdRecord.value : "admin");
}

async function handleLogin(request, env) {
  if (request.method !== "POST") return corsResponse({ success: false }, 405);
  try {
    const body = await request.json();
    const pwdRecord = await env.DB.prepare("SELECT value FROM config WHERE key = 'admin_password'").first();
    const expected = pwdRecord ? pwdRecord.value : "admin";
    if (body.password === expected) return corsResponse({ success: true, token: expected });
    return corsResponse({ success: false, message: "密码错误，解锁失败！" }, 401);
  } catch (err) { return corsResponse({ success: false }, 400); }
}

async function handleConfig(request, env) {
  const db = env.DB;
  if (request.method === "GET") {
    const tgRecord = await db.prepare("SELECT value FROM config WHERE key = 'telegram_config'").first();
    const cronRecord = await db.prepare("SELECT value FROM config WHERE key = 'cron_config'").first();
    const { results: accounts } = await db.prepare("SELECT id, name, accountId, apiToken, customLimit, active, lastChecked, groupName, remark FROM accounts").all();
    return corsResponse({
      success: true,
      telegram: tgRecord ? JSON.parse(tgRecord.value) : {},
      cron: cronRecord ? JSON.parse(cronRecord.value) : { frequency: 10 },
      accounts: accounts.map(a => ({
        ...a, active: a.active === 1,
        apiToken: a.apiToken ? a.apiToken.slice(0, 4) + "****************" + a.apiToken.slice(-4) : ""
      }))
    });
  }
  if (request.method === "POST") {
    try {
      const body = await request.json();
      if (body.adminPassword) await db.prepare("UPDATE config SET value = ? WHERE key = 'admin_password'").bind(body.adminPassword).run();
      if (body.telegram) await db.prepare("UPDATE config SET value = ? WHERE key = 'telegram_config'").bind(JSON.stringify(body.telegram)).run();
      if (body.cron) await db.prepare("UPDATE config SET value = ? WHERE key = 'cron_config'").bind(JSON.stringify(body.cron)).run();
      if (body.accounts) {
        // 同步删除前端未提交的账号
        const clientIds = body.accounts.map(a => a.id).filter(Boolean);
        if (clientIds.length > 0) {
          const placeholders = clientIds.map(() => "?").join(",");
          await db.prepare(`DELETE FROM accounts WHERE id NOT IN (${placeholders})`).bind(...clientIds).run();
        } else {
          await db.prepare("DELETE FROM accounts").run();
        }

        for (const ac of body.accounts) {
          const existing = await db.prepare("SELECT apiToken, remark FROM accounts WHERE id = ?").bind(ac.id).first();
          let finalToken = ac.apiToken;
          if (existing && (!ac.apiToken || ac.apiToken.includes("*"))) finalToken = existing.apiToken;
          let finalRemark = ac.remark;
          if (finalRemark === undefined && existing) finalRemark = existing.remark || '';
          
          await db.prepare("INSERT INTO accounts (id, name, accountId, apiToken, customLimit, active, lastChecked, groupName, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, accountId = excluded.accountId, apiToken = excluded.apiToken, customLimit = excluded.customLimit, active = excluded.active, groupName = excluded.groupName, remark = excluded.remark").bind(
            ac.id, ac.name, ac.accountId, finalToken, ac.customLimit || 100000, ac.active ? 1 : 0, ac.lastChecked || Date.now(), ac.groupName || 'Default', finalRemark || ''
          ).run();
        }
      }
      return corsResponse({ success: true, message: "配置合并更新成功！" });
    } catch (err) { return corsResponse({ success: false, message: err.message }, 400); }
  }
}

async function handleDeleteAccount(request, env, path) {
  if (request.method !== "DELETE") return corsResponse({ success: false }, 405);
  const id = path.split("/").pop();
  await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM history WHERE accountId = ?").bind(id).run();
  return corsResponse({ success: true });
}

async function handleManualRefresh(request, env, ctx) {
  if (request.method !== "POST") return corsResponse({ success: false }, 405);
  await runMonitoringTask(env, ctx);
  return corsResponse({ success: true });
}

function getTelegramUrl(botToken, apiMethod = "sendMessage") {
  let cleanToken = botToken.trim().replace(/^(bot:?|bot\/)/i, '').trim();
  return `https://api.telegram.org/bot${cleanToken}/${apiMethod}`;
}

async function handleTestTelegram(request, env) {
  if (request.method !== "POST") return corsResponse({ success: false }, 405);
  try {
    const body = await request.json();
    const botToken = body.botToken;
    const chatId = body.chatId;
    if (!botToken || !chatId) return corsResponse({ success: false, message: "Bot Token 或 Chat ID 不能为空" }, 400);
    const targetUrl = getTelegramUrl(botToken, "sendMessage");
    const response = await fetch(targetUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId.trim(), text: "🔔 通道连通性测试成功！您的 Cloudflare 业务流量控制台已成功绑定 Telegram 告警链路。" }) });
    if (response.ok) return corsResponse({ success: true, message: "测试消息发送成功，请前往 Telegram 查收。" });
    return corsResponse({ success: false, message: `发送失败: 请确认 Token/ChatID 是否有效` });
  } catch (err) { return corsResponse({ success: false, message: err.message }, 500); }
}

async function handlePushBrag(request, env) {
  if (request.method !== "POST") return corsResponse({ success: false }, 405);
  try {
    const db = env.DB;
    const tgRecord = await db.prepare("SELECT value FROM config WHERE key = 'telegram_config'").first();
    const telegram = tgRecord ? JSON.parse(tgRecord.value) : { enabled: false };
    if (!telegram.enabled || !telegram.botToken || !telegram.chatId) {
      return corsResponse({ success: false, message: "推送失败：请先配置并启用 Telegram 报警通道！" }, 400);
    }
    
    const { results: accounts } = await db.prepare("SELECT * FROM accounts WHERE active = 1").all();
    let totalRequests = 0;
    let maxUsage = 0, minUsage = Infinity;
    let maxAccountName = '无', minAccountName = '无';
    
    for (const ac of accounts) {
      const latest = await db.prepare("SELECT totalRequests FROM history WHERE accountId = ? ORDER BY timestamp DESC LIMIT 1").bind(ac.id).first();
      const totalToday = latest ? latest.totalRequests : 0;
      totalRequests += totalToday;
      
      if (totalToday > maxUsage) {
        maxUsage = totalToday;
        maxAccountName = ac.name;
      }
      if (totalToday < minUsage) {
        minUsage = totalToday;
        minAccountName = ac.name;
      }
    }
    if (minUsage === Infinity) minUsage = 0;
    const avgUsage = accounts.length > 0 ? Math.round(totalRequests / accounts.length) : 0;
    
    let bragMsg = `📊 *CF Usage Monitor - 节点集群能效战报* 📊\n\n`;
    bragMsg += `☁️ *节点托管实例*: 已统筹运行 *${accounts.length}* 个独立节点\n`;
    bragMsg += `🔥 *本日总吞吐请求*: *${totalRequests.toLocaleString()}* 次\n`;
    bragMsg += `🥇 *最高能耗节点*: [${maxAccountName}] (*${maxUsage.toLocaleString()}* 次)\n`;
    bragMsg += `💤 *最闲置温和节点*: [${minAccountName}] (*${minUsage.toLocaleString()}* 次)\n`;
    bragMsg += `🧪 *平均节点负载水位*: *${avgUsage.toLocaleString()}* 次/节点\n\n`;
    bragMsg += `💡 *评估结论*: 当前集群运行状态健康良好。平均节点负载模型运转完美。`;
    
    const targetUrl = getTelegramUrl(telegram.botToken, "sendMessage");
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: telegram.chatId.trim(), text: bragMsg, parse_mode: "Markdown" })
    });
    
    if (response.ok) {
      return corsResponse({ success: true, message: "一键推送 TG 成功！" });
    } else {
      return corsResponse({ success: false, message: `推送失败: ${response.statusText}` });
    }
  } catch (err) {
    return corsResponse({ success: false, message: err.message }, 500);
  }
}

// =======================
// 3. 统计查询 API 与 核心科学计算
// =======================
async function handleUsage(request, env) {
  const db = env.DB;
  const { results: accounts } = await db.prepare("SELECT * FROM accounts").all();
  const accountsStatus = [];
  let totalRequests = 0, totalLimit = 0, activeCount = 0, riskCount = 0;

  const now = new Date();
  const utcTodayStr = now.toISOString().slice(0, 10);
  const utcYesterdayStr = new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const monthPrefix = utcTodayStr.slice(0, 7);

  const dayStartTimestamp = new Date(utcTodayStr + "T00:00:00Z").getTime();
  let hoursElapsed = (Date.now() - dayStartTimestamp) / 3600000;
  if (hoursElapsed <= 0.1) hoursElapsed = 0.1;

  for (const ac of accounts) {
    const latest = await db.prepare("SELECT * FROM history WHERE accountId = ? ORDER BY timestamp DESC LIMIT 1").bind(ac.id).first();
    const totalToday = latest ? latest.totalRequests : 0;
    
    const yesterdayRecord = await db.prepare("SELECT totalRequests FROM history WHERE id = ?").bind(ac.id + "_day_" + utcYesterdayStr).first();
    const yesterdayTotal = yesterdayRecord ? yesterdayRecord.totalRequests : 0;

    const { results: monthRecords } = await db.prepare("SELECT totalRequests FROM history WHERE accountId = ? AND id LIKE ?").bind(ac.id, ac.id + "_day_" + monthPrefix + "-%").all();
    const monthTotal = monthRecords.reduce((sum, r) => sum + r.totalRequests, 0);

    const { results: todayHrRecords } = await db.prepare("SELECT totalRequests FROM history WHERE accountId = ? AND id LIKE ? ORDER BY timestamp ASC").bind(ac.id, ac.id + "_hr_" + utcTodayStr + "T%").all();
    
    let maxHourlyRate = 0;
    let prevReq = 0;
    for (let r of todayHrRecords) {
      let delta = r.totalRequests - prevReq;
      if (delta > maxHourlyRate) maxHourlyRate = delta;
      prevReq = r.totalRequests;
    }
    let currentDelta = totalToday - prevReq;
    if (currentDelta > maxHourlyRate) maxHourlyRate = currentDelta;

    const maxLimit = ac.customLimit || 100000;
    const avgHourlyRate = totalToday / hoursElapsed;

    const etaFastest = maxHourlyRate > 0 ? (maxLimit - totalToday) / maxHourlyRate : -1;
    const etaAvg = avgHourlyRate > 0 ? (maxLimit - totalToday) / avgHourlyRate : -1;

    const percentage = maxLimit > 0 ? (totalToday / maxLimit) * 100 : 0;
    let risk = "green";
    if (percentage >= 95) { risk = "red"; riskCount++; }
    else if (percentage >= 85) { risk = "orange"; riskCount++; }
    else if (percentage >= 65) risk = "yellow";

    accountsStatus.push({
      id: ac.id, name: ac.name, groupName: ac.groupName, remark: ac.remark, accountId: ac.accountId, 
      total: totalToday, max: maxLimit, percentage, 
      yesterdayTotal: yesterdayTotal, 
      monthTotal: monthTotal, 
      etaFastest: etaFastest,
      etaAvg: etaAvg,
      maxHourlyRate: maxHourlyRate,
      avgHourlyRate: avgHourlyRate,
      risk, active: ac.active === 1, 
      lastChecked: ac.lastChecked || Date.now()
    });

    if (ac.active === 1) { totalRequests += totalToday; totalLimit += maxLimit; activeCount++; }
  }

  return corsResponse({
    success: true, 
    summary: { totalRequests, totalLimit, totalRemaining: Math.max(0, totalLimit - totalRequests), percentage: totalLimit > 0 ? (totalRequests / totalLimit) * 100 : 0, activeCount, totalAccounts: accounts.length, riskCount, updateTime: Date.now() },
    accounts: accountsStatus
  });
}

async function handleTrend(request, env) {
  const url = new URL(request.url);
  const period = url.searchParams.get("period") || "today";
  
  const now = new Date();
  const utcTodayStr = now.toISOString().slice(0, 10);
  const utcYesterdayStr = new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const monthStr = utcTodayStr.slice(0, 7);

  const { results: activeAccounts } = await env.DB.prepare("SELECT id, name FROM accounts").all();
  const currentAccountsMap = new Map(activeAccounts.map(a => [a.id, a.name]));

  let query = "", param = "";
  if (period === "today") {
    query = "SELECT * FROM history WHERE id LIKE '%_hr_' || ? || '%' ORDER BY timestamp ASC";
    param = utcTodayStr;
  } else if (period === "yesterday") {
    query = "SELECT * FROM history WHERE id LIKE '%_hr_' || ? || '%' ORDER BY timestamp ASC";
    param = utcYesterdayStr;
  } else if (period === "month") {
    query = "SELECT * FROM history WHERE id LIKE '%_day_' || ? || '%' ORDER BY timestamp ASC";
    param = monthStr;
  }

  const { results: rawHistory } = await env.DB.prepare(query).bind(param).all();
  const trendMap = new Map();
  
  for (const h of rawHistory) {
    if (!currentAccountsMap.has(h.accountId)) continue;
    const runtimeName = currentAccountsMap.get(h.accountId);

    const cstDate = new Date(h.timestamp + 8 * 60 * 60 * 1000);
    let label = "";
    if (period === "today" || period === "yesterday") {
      label = cstDate.getUTCHours() + ":00";
    } else if (period === "month") {
      label = (cstDate.getUTCMonth() + 1) + "/" + cstDate.getUTCDate();
    }

    if (!trendMap.has(label)) trendMap.set(label, { name: label, '总计': 0 });
    const entry = trendMap.get(label);
    entry[runtimeName] = h.totalRequests;
  }

  const trendData = Array.from(trendMap.values());
  trendData.forEach(point => {
    let sum = 0;
    for (let key in point) {
      if (key !== 'name' && key !== '总计') sum += point[key];
    }
    point['总计'] = sum;
  });

  return corsResponse({ success: true, trend: trendData });
}

async function handleCronLog(request, env) {
  try {
    const { results } = await env.DB.prepare("SELECT * FROM cron_log ORDER BY timestamp DESC LIMIT 15").all();
    return corsResponse({ success: true, logs: results });
  } catch(e) {
    return corsResponse({ success: true, logs: [] });
  }
}

async function handleSystemState(request, env) {
  return corsResponse({ success: true, system: { version: "Pro V3.0" } });
}

// =======================
// 4. GraphQL 请求采集器与监控任务
// =======================
async function fetchRealUsage(accountId, apiToken) {
  const API = "https://api.cloudflare.com/client/v4/graphql";
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);

  const variables = { AccountID: accountId, filter: { datetime_geq: dayStart.toISOString(), datetime_leq: now.toISOString() } };
  const query = `query getBillingMetrics($AccountID: String!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
    viewer {
        accounts(filter: {accountTag: $AccountID}) {
            pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: $filter) { sum { requests } }
            workersInvocationsAdaptive(limit: 10000, filter: $filter) { sum { requests } }
        }
    }
  }`;

  const cfResponse = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiToken}` }, body: JSON.stringify({ query, variables }) });
  if (!cfResponse.ok) throw new Error(`CF API Error: ${cfResponse.status}`);
  const result = await cfResponse.json();
  if (result.errors && result.errors.length > 0) throw new Error(result.errors[0].message);

  const accountData = result?.data?.viewer?.accounts?.[0];
  if (!accountData) throw new Error("无权读取分析数据");

  const pagesSum = (accountData.pagesFunctionsInvocationsAdaptiveGroups || []).reduce((acc, item) => acc + (item?.sum?.requests || 0), 0);
  const workersSum = (accountData.workersInvocationsAdaptive || []).reduce((acc, item) => acc + (item?.sum?.requests || 0), 0);

  return { workersRequests: workersSum, pagesRequests: pagesSum, totalRequests: workersSum + pagesSum, apiStatus: "success" };
}

async function runMonitoringTask(env, ctx) {
  const startTime = Date.now();
  let successCount = 0;
  let totalSumScraped = 0;
  let cronMsg = "";

  const db = env.DB;
  const { results: accounts } = await db.prepare("SELECT * FROM accounts WHERE active = 1").all();
  const tgRecord = await db.prepare("SELECT value FROM config WHERE key = 'telegram_config'").first();
  const telegram = tgRecord ? JSON.parse(tgRecord.value) : { enabled: false };

  const todayStr = new Date().toISOString().slice(0, 10);
  const hourStr = new Date().toISOString().slice(0, 13);
  
  // 北京时间换算
  const cstDate = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const cstTodayStr = cstDate.toISOString().slice(0, 10);
  const cstHour = cstDate.getUTCHours();

  let snapBreakdown = {};

  for (const ac of accounts) {
    try {
      const data = await fetchRealUsage(ac.accountId, ac.apiToken);
      const timestamp = Date.now();
      
      // 突发流量暴增应急检测
      if (telegram.enabled && telegram.surgeAlertEnabled && telegram.botToken && telegram.chatId) {
        const thirtyMinsAgo = Date.now() - 30 * 60 * 1000;
        const prevRecord = await db.prepare("SELECT totalRequests, timestamp FROM history WHERE accountId = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1").bind(ac.id, thirtyMinsAgo).first();
        
        let delta = 0;
        if (prevRecord) {
          delta = data.totalRequests >= prevRecord.totalRequests ? data.totalRequests - prevRecord.totalRequests : data.totalRequests;
        }
        
        const alertLevel = "surge_10k";
        if (delta >= 10000) {
          const lastSurgeAlert = await db.prepare("SELECT timestamp FROM alerts_log WHERE accountId = ? AND threshold = ? ORDER BY timestamp DESC LIMIT 1").bind(ac.id, alertLevel).first();
          const coolDownPeriod = 30 * 60 * 1000;
          
          if (!lastSurgeAlert || (Date.now() - lastSurgeAlert.timestamp > coolDownPeriod)) {
            const targetUrl = getTelegramUrl(telegram.botToken, "sendMessage");
            const alertMsg = `🚨 *突发流量暴增告警* 🚨\n\n` +
              `👤 *别名*: [${ac.name}]\n` +
              `⚠️ *突增流量*: 30分钟内新增 *${delta.toLocaleString()}* 次请求！\n` +
              `📊 *当前累积*: ${data.totalRequests.toLocaleString()} / ${ac.customLimit.toLocaleString()} 次`;
              
            const fireAlert = fetch(targetUrl, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: telegram.chatId.trim(), text: alertMsg, parse_mode: "Markdown" })
            }).then(() => {
              return db.prepare("INSERT INTO alerts_log (accountId, threshold, date, timestamp) VALUES (?, ?, ?, ?)").bind(ac.id, alertLevel, todayStr, Date.now()).run();
            }).catch(e => console.error("Surge TG push failed", e));

            if (ctx) ctx.waitUntil(fireAlert);
          }
        }
      }

      await db.prepare("INSERT INTO history (id, accountId, accountName, timestamp, workersRequests, pagesRequests, totalRequests, limitRequests, apiStatus) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET workersRequests = excluded.workersRequests, pagesRequests = excluded.pagesRequests, totalRequests = excluded.totalRequests, timestamp = excluded.timestamp, apiStatus = excluded.apiStatus").bind(
        ac.id + "_day_" + todayStr, ac.id, ac.name, timestamp, data.workersRequests, data.pagesRequests, data.totalRequests, ac.customLimit, data.apiStatus
      ).run();
      
      await db.prepare("INSERT INTO history (id, accountId, accountName, timestamp, workersRequests, pagesRequests, totalRequests, limitRequests, apiStatus) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET totalRequests = excluded.totalRequests, timestamp = excluded.timestamp, apiStatus = excluded.apiStatus").bind(
        ac.id + "_hr_" + hourStr, ac.id, ac.name, timestamp, data.workersRequests, data.pagesRequests, data.totalRequests, ac.customLimit, data.apiStatus
      ).run();
      
      await db.prepare("UPDATE accounts SET lastChecked = ? WHERE id = ?").bind(timestamp, ac.id).run();
      
      successCount++;
      totalSumScraped += data.totalRequests;
      snapBreakdown[ac.name] = data.totalRequests;

      // 额度梯度里程碑报警
      if (telegram.enabled && telegram.botToken && telegram.chatId) {
        const usageRate = (data.totalRequests / ac.customLimit) * 100;
        const alertThreshold = parseInt(telegram.alertThreshold) || 90;
        const milestones = [50, 75, 90, 95];

        for (const pct of milestones) {
          if (usageRate >= pct && pct >= alertThreshold) {
            const alertLevel = `pct_${pct}`;
            const hasAlerted = await db.prepare("SELECT * FROM alerts_log WHERE accountId = ? AND threshold = ? AND date = ?").bind(ac.id, alertLevel, todayStr).first();
            if (!hasAlerted) {
              const alertMsg = `🔔 额度预警: [${ac.name}] 当日额度使用率已达 ${usageRate.toFixed(1)}% (触发梯度: ${pct}%)`;
              const targetUrl = getTelegramUrl(telegram.botToken, "sendMessage");
              const fireMilestone = fetch(targetUrl, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: telegram.chatId.trim(), text: `${alertMsg}\n当前消耗: ${data.totalRequests.toLocaleString()} 次\n配置上限: ${ac.customLimit.toLocaleString()} 次` })
              }).then(() => {
                return db.prepare("INSERT INTO alerts_log (accountId, threshold, date, timestamp) VALUES (?, ?, ?, ?)").bind(ac.id, alertLevel, todayStr, Date.now()).run();
              }).catch(e => console.error("Milestone TG push failed", e));

              if (ctx) ctx.waitUntil(fireMilestone);
            }
          }
        }
      }
    } catch (err) { 
       cronMsg += `[${ac.name}异常: ${err.message}] `;
    }
  }

  // 定时发送前24小时用量简报
  if (telegram.enabled && telegram.botToken && telegram.chatId) {
    const reportTime = telegram.dailyReportTime || "08:00";
    const [targetHour] = reportTime.split(":").map(Number);
    
    if (cstHour === targetHour) {
      const hasSentToday = await db.prepare("SELECT * FROM alerts_log WHERE accountId = 'global' AND threshold = 'daily_report' AND date = ?").bind(cstTodayStr).first();
      if (!hasSentToday) {
        const yesterdayDate = new Date(Date.now() + 8 * 3600 * 1000 - 24 * 3600 * 1000);
        const yesterdayStr = yesterdayDate.toISOString().slice(0, 10);
        
        const { results: yesterdayHist } = await db.prepare("SELECT * FROM history WHERE id LIKE ?").bind("%_day_" + yesterdayStr).all();

        let reportMsg = `📊 *CF Usage Monitor - 每日汇总简报* 📊\n`;
        reportMsg += `📅 统计周期: 北京时间 ${yesterdayStr} 08:00 至 今日 07:59\n\n`;

        let grandTotal = 0, grandLimit = 0;

        if (yesterdayHist.length === 0) {
          reportMsg += `⚠️ 未找到昨日结算数据，请检查定时采集器运行状态。`;
        } else {
          for (const h of yesterdayHist) {
            const usagePercent = h.limitRequests > 0 ? ((h.totalRequests / h.limitRequests) * 100).toFixed(1) : "0.0";
            const partialId = h.accountId.slice(0, 4) + "****************" + h.accountId.slice(-4);
            reportMsg += `👤 *节点*: ${h.accountName}\n`;
            reportMsg += `   ├ 账号: \`${partialId}\`\n`;
            reportMsg += `   └ 今日额度: *${h.totalRequests.toLocaleString()}* / ${h.limitRequests.toLocaleString()} 次 (${usagePercent}%)\n\n`;
            
            grandTotal += h.totalRequests;
            grandLimit += h.limitRequests;
          }

          const grandPercent = grandLimit > 0 ? ((grandTotal / grandLimit) * 100).toFixed(1) : "0.0";
          reportMsg += `📈 *全栈汇总信息*:\n`;
          reportMsg += `   ├ 总消耗请求: *${grandTotal.toLocaleString()}* 次\n`;
          reportMsg += `   ├ 剩余总配额: *${Math.max(0, grandLimit - grandTotal).toLocaleString()}* 次\n`;
          reportMsg += `   └ 整体使用率: *${grandPercent}%*\n`;
        }

        const targetUrl = getTelegramUrl(telegram.botToken, "sendMessage");
        const sendReport = fetch(targetUrl, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: telegram.chatId.trim(), text: reportMsg, parse_mode: "Markdown" })
        }).then(() => {
          return db.prepare("INSERT INTO alerts_log (accountId, threshold, date, timestamp) VALUES (?, ?, ?, ?)").bind("global", "daily_report", cstTodayStr, Date.now()).run();
        }).catch(e => console.error("Daily report TG push failed", e));

        if (ctx) ctx.waitUntil(sendReport);
      }
    }
  }

  // 自动清理过期历史
  try {
    const cleanDate = Date.now() - 30 * 24 * 3600 * 1000;
    await db.prepare("DELETE FROM history WHERE timestamp < ?").bind(cleanDate).run();
    await db.prepare("DELETE FROM alerts_log WHERE timestamp < ?").bind(cleanDate).run();
  } catch (err) {}

  const execTime = Date.now() - startTime;
  const status = successCount === accounts.length ? 'success' : 'warning';
  
  const logPayload = {
     summaryText: `成功拉取 ${successCount}/${accounts.length} 个请求源。 ${cronMsg}`,
     breakdown: snapBreakdown
  };

  try {
      await db.prepare("INSERT INTO cron_log (timestamp, status, message, totalRequests, executionTimeMs) VALUES (?, ?, ?, ?, ?)").bind(
         Date.now(), status, JSON.stringify(logPayload), totalSumScraped, execTime
      ).run();
      await db.prepare("DELETE FROM cron_log WHERE id NOT IN (SELECT id FROM cron_log ORDER BY timestamp DESC LIMIT 100)").run();
  } catch(e) {}
}

function corsResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=UTF-8", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS" }});
}

// =======================
// 5. 前端 Web UI (雙色自適應模組化大盘)
// =======================
function serveDashboardHTML(request, env) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CF Usage Monitor Pro ☁️</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/apexcharts"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <script>
        function updateTheme() { document.documentElement.classList.toggle('dark', window.matchMedia('(prefers-color-scheme: dark)').matches); }
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateTheme);
        updateTheme();
        tailwind.config = { darkMode: 'class', theme: { extend: { colors: { cf: { dark: '#0d1117', panel: '#161b22', border: '#30363d', primary: '#3b82f6', red: '#da3633', yellow: '#d29922', green: '#238636' } } } } };
    </script>
    <style>
        body { font-family: 'Inter', sans-serif; transition: background-color 0.3s, color 0.3s; }
        .font-mono { font-family: 'JetBrains Mono', monospace; }
        .glass-panel { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .dark .glass-panel { background: #161b22; border: 1px solid #30363d; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .active-tab { background-color: rgba(0, 0, 0, 0.05); color: #000; }
        .dark .active-tab { background-color: rgba(255, 255, 255, 0.1); color: #fff; }
        .acc-content { display: none; margin-top: 16px; border-top: 1px solid #e2e8f0; padding-top: 16px; animation: fadeIn 0.3s; }
        .dark .acc-content { border-top: 1px solid #30363d; }
        .acc-content.open { display: block; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
    </style>
</head>
<body class="min-h-screen bg-slate-50 text-slate-800 dark:bg-[#0d1117] dark:text-[#c9d1d9] text-sm pb-12">
    <!-- 强制首次/初始密码修改弹窗 -->
    <div id="forced-password-modal" class="hidden fixed inset-0 z-[100] bg-slate-900/90 backdrop-blur-md flex items-center justify-center p-4">
        <div class="bg-white dark:bg-[#161b22] border border-slate-200 dark:border-[#30363d] p-6 max-w-sm w-full space-y-4 rounded-xl shadow-2xl">
            <h3 class="text-base font-bold text-cf-red border-b border-slate-200 dark:border-cf-border pb-3">🚨 强制初始化管理密码</h3>
            <p class="text-xs text-slate-500 leading-relaxed">系统检测到您当前正使用默认初始密码 [admin]。为了系统及配置安全，您<b>必须</b>先设置并确认一个新的安全管理密码：</p>
            <div>
                <label class="text-[11px] text-slate-400 block mb-1">输入自定义新密码（明文可见）</label>
                <input type="text" id="forced-new-pwd" placeholder="禁止使用 admin" class="w-full px-4 py-2 bg-slate-50 dark:bg-cf-dark border border-slate-300 dark:border-cf-border rounded-lg focus:outline-none focus:border-cf-primary font-mono text-slate-900 dark:text-white text-center font-bold">
            </div>
            <button onclick="submitForcedPassword()" class="w-full py-2.5 bg-cf-primary hover:bg-blue-600 text-white rounded-lg text-xs font-bold shadow-md shadow-blue-500/20 transition-all">保存密码并自动登入</button>
        </div>
    </div>

    <!-- 气泡密码锁解锁弹窗 -->
    <div id="unlock-modal" class="hidden fixed inset-0 z-50 bg-slate-950/70 dark:bg-[#0d1117]/80 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-white dark:bg-[#161b22] border border-slate-200 dark:border-[#30363d] p-6 max-w-sm w-full space-y-4 rounded-xl shadow-2xl">
            <h3 class="text-base font-bold text-slate-900 dark:text-white border-b border-slate-200 dark:border-cf-border pb-3">🔒 验证管理员权限</h3>
            <p class="text-xs text-slate-500">此模块已锁定，请输入大盘管理密码解锁控制台权限：</p>
            <input type="password" id="unlock-pwd-input" placeholder="输入控制台密码" class="w-full px-4 py-2 bg-slate-50 dark:bg-cf-dark border border-slate-300 dark:border-cf-border rounded-lg focus:outline-none focus:border-cf-primary font-mono text-slate-900 dark:text-white text-center tracking-widest">
            <div class="flex justify-end gap-2 pt-2">
                <button onclick="closeUnlockPrompt()" class="px-4 py-2 bg-slate-100 dark:bg-cf-dark border border-slate-300 dark:border-cf-border text-slate-700 dark:text-slate-300 hover:text-slate-900 rounded text-xs">取消</button>
                <button onclick="submitUnlock()" class="px-4 py-2 bg-cf-primary hover:bg-blue-600 text-white rounded font-bold">验证并解锁</button>
            </div>
        </div>
    </div>

    <div class="max-w-[1440px] mx-auto p-4 sm:p-6 space-y-6">
        <header class="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-200 dark:border-cf-border gap-4">
            <div class="flex items-center gap-3">
                <div class="p-2 bg-cf-primary/10 rounded-lg"><span class="text-xl">☁️</span></div>
                <div>
                    <h1 class="text-lg font-bold text-slate-900 dark:text-white tracking-wide">CF 请求合规洞察控制台 ☁️</h1>
                    <div class="flex items-center gap-2 mt-1 text-[10px] text-slate-500 dark:text-slate-400 font-mono">
                        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-cf-green"></span> 数据中心健康度 100%</span>
                    </div>
                </div>
            </div>
            <div class="flex flex-wrap items-center gap-4">
                <div class="flex items-center gap-2">
                    <span id="auto-refresh-countdown" class="text-xs text-slate-500 dark:text-slate-400 font-mono hidden"></span>
                    <select id="auto-refresh-select" onchange="changeAutoRefresh()" class="bg-white dark:bg-[#161b22] border border-slate-200 dark:border-cf-border rounded px-2.5 py-1.5 text-xs text-slate-700 dark:text-slate-300 focus:outline-none">
                        <option value="0">自动刷新：已关闭</option>
                        <option value="60000">自动刷新：1分钟</option>
                        <option value="120000">自动刷新：2分钟</option>
                        <option value="300000">自动刷新：5分钟</option>
                        <option value="600000">自动刷新：10分钟</option>
                    </select>
                </div>
                <div class="flex bg-slate-100 dark:bg-cf-dark border border-slate-200 dark:border-cf-border rounded-lg p-1">
                    <button onclick="switchTab('dashboard')" id="tab-dashboard" class="px-3 py-1.5 rounded-md text-xs font-semibold active-tab">全局大盘</button>
                    <button onclick="switchTab('settings')" id="tab-settings" class="px-3 py-1.5 rounded-md text-xs font-semibold text-slate-500">业务配置中心</button>
                    <button onclick="toggleLockState()" id="lock-btn" class="px-3 py-1.5 rounded-md text-xs font-semibold text-cf-primary ml-1">🔒 解锁配置</button>
                </div>
            </div>
        </header>

        <main id="view-dashboard" class="space-y-6">
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div class="glass-panel p-5 relative overflow-hidden">
                    <p class="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-2">今日并发总计请求 (结算至明早8点)</p>
                    <h3 id="g-total-req" class="text-2xl font-black text-slate-900 dark:text-white font-mono">0</h3>
                    <div class="w-full bg-slate-200 dark:bg-cf-dark h-1 mt-3 rounded-full overflow-hidden"><div id="g-bar" class="bg-cf-primary h-full rounded-full w-0"></div></div>
                </div>
                <div class="glass-panel p-5">
                    <p class="text-[10px] text-slate-400 font-bold uppercase mb-2">安全理论配额余量</p>
                    <h3 id="g-total-rem" class="text-2xl font-black text-slate-900 dark:text-white font-mono">0</h3>
                </div>
                <div class="glass-panel p-5">
                    <p class="text-[10px] text-slate-400 font-bold uppercase mb-2">实时挂载请求源</p>
                    <h3 id="g-active-count" class="text-2xl font-black text-slate-900 dark:text-white font-mono">0</h3>
                </div>
                <div class="glass-panel p-5">
                    <p class="text-[10px] text-slate-400 font-bold uppercase mb-2">智能风险评估</p>
                    <h3 id="g-risk" class="text-xl font-black text-cf-green mt-1">负载正常</h3>
                </div>
            </div>

            <div class="glass-panel p-5 space-y-4">
                <div class="flex justify-between items-center">
                    <h3 class="text-sm font-bold text-slate-900 dark:text-white">📈 全业务请求流量时空透视</h3>
                    <div class="flex bg-slate-100 dark:bg-cf-dark border border-slate-200 dark:border-cf-border rounded-lg p-1">
                        <button onclick="loadTrend('today')" id="p-today" class="px-3 py-1 rounded-md text-[11px] font-semibold bg-white dark:bg-cf-border text-slate-800 dark:text-white shadow-sm">今日24小时</button>
                        <button onclick="loadTrend('yesterday')" id="p-yesterday" class="px-3 py-1 rounded-md text-[11px] font-semibold text-slate-500 hover:text-slate-900 dark:hover:text-white">昨日24小时</button>
                        <button onclick="loadTrend('month')" id="p-month" class="px-3 py-1 rounded-md text-[11px] font-semibold text-slate-500 hover:text-slate-900 dark:hover:text-white">本月累计报告</button>
                    </div>
                </div>
                <div id="chart-container" class="h-[300px] w-full"></div>
            </div>

            <div class="space-y-3">
                <div class="flex items-center justify-between px-2">
                    <h3 class="font-bold text-xs text-slate-400 uppercase tracking-wide">业务请求状态矩阵 & 深度演算预测</h3>
                    <button id="manual-refresh-btn" onclick="refreshData()" class="text-xs text-cf-primary hover:text-blue-400 font-bold">手动强制拉取数据 🔄</button>
                </div>
                <div id="accounts-list" class="grid grid-cols-1 gap-3"></div>
            </div>

            <div class="glass-panel p-5 mt-6">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">⏱️ 定时任务 (Cron) 守护进程高精追踪 (近5期快照)</h3>
                    <button onclick="loadCronLogs()" class="text-xs text-cf-primary hover:text-blue-400 font-bold">刷新同步流</button>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full text-left text-[11px]">
                        <thead>
                            <tr class="border-b border-slate-200 dark:border-cf-border text-slate-500">
                                <th class="pb-2 w-[15%]">快照时间(北京)</th>
                                <th class="pb-2 w-[8%]">通信耗时</th>
                                <th class="pb-2 w-[12%]">最新合并请求量</th>
                                <th class="pb-2 w-[25%]">系统同步状态反馈</th>
                                <th class="pb-2 w-[40%]">各请求源单日独立明细 (今日累计)</th>
                            </tr>
                        </thead>
                        <tbody id="cron-log-table" class="text-slate-700 dark:text-slate-300"></tbody>
                    </table>
                </div>
            </div>
        </main>
        
        <main id="view-settings" class="hidden space-y-6">
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div class="lg:col-span-1 space-y-6">
                    <div class="glass-panel p-5 space-y-4">
                        <h3 class="text-sm font-bold text-slate-900 dark:text-white">🔐 安全策略认证</h3>
                        <div>
                            <label class="block text-xs text-slate-400 mb-1">控制台独立修改密码</label>
                            <div class="flex gap-2">
                                <input type="text" id="settings-pwd" class="flex-1 bg-slate-50 dark:bg-cf-dark border border-slate-200 dark:border-cf-border rounded p-2 text-xs font-mono focus:outline-none focus:border-cf-primary font-bold" placeholder="输入新密码(明文可见)">
                                <button onclick="confirmChangePassword()" class="px-3 py-2 bg-cf-red hover:bg-red-600 text-white rounded text-xs font-bold transition-all shadow-sm">修改</button>
                            </div>
                        </div>
                    </div>
                    
                    <div class="glass-panel p-5 space-y-4">
                        <h3 class="text-sm font-bold text-slate-900 dark:text-white">🔔 Telegram 告警风控通道</h3>
                        <div class="flex items-center justify-between">
                            <span class="text-xs">开启全时自动化推送监控</span>
                            <input type="checkbox" id="tg-enabled" class="w-4 h-4 rounded text-cf-primary focus:ring-cf-primary">
                        </div>
                        <div>
                            <label class="block text-xs text-slate-400 mb-1">Bot API Token</label>
                            <input type="text" id="tg-token" class="w-full bg-slate-50 dark:bg-cf-dark border border-slate-200 dark:border-cf-border rounded p-2 text-xs font-mono focus:outline-none">
                        </div>
                        <div>
                            <label class="block text-xs text-slate-400 mb-1">接收端 Chat ID</label>
                            <input type="text" id="tg-chatid" class="w-full bg-slate-50 dark:bg-cf-dark border border-slate-200 dark:border-cf-border rounded p-2 text-xs font-mono focus:outline-none">
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <div>
                                <label class="block text-xs text-slate-400 mb-1">定时日报时间</label>
                                <input type="text" id="tg-time" class="w-full bg-slate-50 dark:bg-cf-dark border border-slate-200 dark:border-cf-border rounded p-2 text-xs font-mono text-center" placeholder="08:00">
                            </div>
                            <div>
                                <label class="block text-xs text-slate-400 mb-1">告警阈值 (%)</label>
                                <input type="number" id="tg-threshold" class="w-full bg-slate-50 dark:bg-cf-dark border border-slate-200 dark:border-cf-border rounded p-2 text-xs font-mono text-center" placeholder="90">
                            </div>
                        </div>
                        <div class="flex items-center justify-between">
                            <span class="text-xs">瞬时高并发激增告警</span>
                            <input type="checkbox" id="tg-surge-alert" class="w-4 h-4 rounded text-cf-primary focus:ring-cf-primary">
                        </div>
                        <div class="grid grid-cols-2 gap-2 pt-2">
                            <button onclick="testTelegramChannel()" class="bg-slate-100 dark:bg-cf-border hover:bg-slate-200 p-2 rounded text-xs font-medium transition-colors">⚡ 测试通道连通</button>
                            <button onclick="pushBragReport()" class="bg-cf-primary/10 text-cf-primary hover:bg-cf-primary/20 p-2 rounded text-xs font-medium transition-colors">🚀 一键推流简报</button>
                        </div>
                    </div>
                </div>

                <div class="lg:col-span-2 glass-panel p-5 space-y-4">
                    <div class="flex justify-between items-center">
                        <h3 class="text-sm font-bold text-slate-900 dark:text-white">📋 Cloudflare 监控请求源核心控制矩阵</h3>
                        <button onclick="addNewAccountRow()" class="bg-cf-primary text-white text-xs px-3 py-1.5 rounded font-bold hover:bg-blue-600 transition-colors">+ 新增业务请求源</button>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-left text-xs">
                            <thead>
                                <tr class="border-b border-slate-200 dark:border-cf-border text-slate-400 font-bold">
                                    <th class="pb-2 w-[15%]">自定义别名</th>
                                    <th class="pb-2 w-[20%]">Account ID</th>
                                    <th class="pb-2 w-[20%]">API Token</th>
                                    <th class="pb-2 w-[12%]">上限额度</th>
                                    <th class="pb-2 w-[10%]">分组</th>
                                    <th class="pb-2 w-[15%]">备注说明</th>
                                    <th class="pb-2 w-[5%] text-center">启用</th>
                                    <th class="pb-2 text-right w-[8%]">管理</th>
                                </tr>
                            </thead>
                            <tbody id="accounts-config-table"></tbody>
                        </table>
                    </div>
                    <div class="flex justify-end pt-4 border-t border-slate-200 dark:border-cf-border">
                        <button onclick="saveGlobalSettings()" class="bg-cf-primary text-white text-xs px-6 py-2.5 rounded-lg font-bold hover:bg-blue-600 shadow-lg shadow-blue-500/10 transition-all">💾 保存全局配置与账号矩阵</button>
                    </div>
                </div>
            </div>
        </main>
    </div>

    <script>
        var token = localStorage.getItem('cf_monitor_token') || '';
        var trendChart = null;
        var autoRefreshTimer = null;
        var countdownTimer = null;
        var nextRefreshTime = 0;
        var pendingUnlockCallback = null;

        function apiFetch(path, options = {}) {
            options.headers = options.headers || {};
            if (token) options.headers['Authorization'] = 'Bearer ' + token;
            return fetch(path, options).then(res => {
                if (res.status === 401) {
                    token = '';
                    localStorage.removeItem('cf_monitor_token');
                    updateLockStateUI();
                    openUnlockPrompt(() => {
                        location.reload();
                    });
                    throw new Error('未授权');
                }
                return res.json();
            });
        }

        function toggleLockState() {
            if(token) {
                token = '';
                localStorage.removeItem('cf_monitor_token');
                updateLockStateUI();
                alert('控制台已成功加锁归档。');
                if (!document.getElementById('view-settings').classList.contains('hidden')) {
                    switchTab('dashboard');
                }
            } else {
                openUnlockPrompt(() => {
                    alert('验证成功，配置权限已就绪！');
                });
            }
        }

        function updateLockStateUI() {
            var btn = document.getElementById('lock-btn');
            if (token) {
                btn.innerHTML = '🔓 已解锁';
                btn.className = 'px-3 py-1.5 rounded-md text-xs font-semibold text-cf-red hover:bg-cf-red/10 ml-1';
            } else {
                btn.innerHTML = '🔒 解锁配置';
                btn.className = 'px-3 py-1.5 rounded-md text-xs font-semibold text-cf-primary hover:bg-cf-primary/10 ml-1';
            }
        }

        function openUnlockPrompt(callback) {
            pendingUnlockCallback = callback;
            document.getElementById('unlock-pwd-input').value = '';
            document.getElementById('unlock-modal').classList.remove('hidden');
        }

        function closeUnlockPrompt() {
            document.getElementById('unlock-modal').classList.add('hidden');
            pendingUnlockCallback = null;
        }

        function submitUnlock() {
            var pwd = document.getElementById('unlock-pwd-input').value;
            fetch('./api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd }) })
            .then(d => d.json()).then(res => {
                if (res.success) { 
                    if (pwd === 'admin') {
                        closeUnlockPrompt();
                        openForcedPasswordSetup();
                    } else {
                        token = res.token; 
                        localStorage.setItem('cf_monitor_token', token); 
                        updateLockStateUI();
                        closeUnlockPrompt();
                        if(pendingUnlockCallback) pendingUnlockCallback();
                    }
                } else {
                    alert('密码错误，解锁失败！');
                }
            });
        }

        function openForcedPasswordSetup() {
            document.getElementById('forced-new-pwd').value = '';
            document.getElementById('forced-password-modal').classList.remove('hidden');
        }

        function submitForcedPassword() {
            const newPwd = document.getElementById('forced-new-pwd').value.trim();
            if (!newPwd) return alert('新密码不能为空！');
            if (newPwd === 'admin') return alert('安全规范：不能继续使用默认密码 admin！');
            
            if (confirm('⚠️ 确定要将管理员新密码设定为 [ ' + newPwd + ' ] 吗？\\n\\n此密码修改后原始密码 admin 将立即失效。')) {
                fetch('./api/config', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer admin'
                    },
                    body: JSON.stringify({ adminPassword: newPwd })
                }).then(res => res.json()).then(res => {
                    if (res.success) {
                        alert('新密码保存成功！正在为您自动进入大盘。');
                        token = newPwd;
                        localStorage.setItem('cf_monitor_token', token);
                        document.getElementById('forced-password-modal').classList.add('hidden');
                        updateLockStateUI();
                        location.reload();
                    } else {
                        alert('保存失败: ' + (res.message || '网络连接异常'));
                    }
                });
            }
        }

        function confirmChangePassword() {
            const newPwd = document.getElementById('settings-pwd').value.trim();
            if (!newPwd) return alert('请输入新的管理密码！');
            if (newPwd === 'admin') return alert('安全规范：管理密码不能设置为默认密码 admin！');

            if (confirm('⚠️ 安全确认：您确定要把后台管理员密码修改为：[ ' + newPwd + ' ] 吗？\\n\\n修改后页面将刷新并自动下线。')) {
                apiFetch('./api/config', {
                    method: 'POST',
                    body: JSON.stringify({ adminPassword: newPwd })
                }).then(res => {
                    if (res.success) {
                        alert('管理密码修改成功！请使用新密码重新登录系统。');
                        token = '';
                        localStorage.removeItem('cf_monitor_token');
                        location.reload();
                    } else {
                        alert('修改失败: ' + (res.message || '未知异常'));
                    }
                });
            }
        }

        function switchTab(tabId) {
            if (tabId === 'settings' && !token) {
                openUnlockPrompt(() => {
                    performSwitchTab(tabId);
                    loadSettingsData();
                });
                return;
            }
            performSwitchTab(tabId);
            if (tabId === 'settings') loadSettingsData();
        }

        function performSwitchTab(tabId) {
            document.querySelectorAll('.active-tab').forEach(el => { el.classList.remove('active-tab', 'bg-white', 'dark:bg-cf-border', 'text-slate-800', 'dark:text-white', 'shadow-sm'); el.classList.add('text-slate-500'); });
            let btn = document.getElementById('tab-' + tabId);
            btn.classList.add('active-tab', 'bg-white', 'dark:bg-cf-border', 'text-slate-800', 'dark:text-white', 'shadow-sm');
            btn.classList.remove('text-slate-500');
            document.getElementById('view-dashboard').classList.add('hidden');
            document.getElementById('view-settings').classList.add('hidden');
            document.getElementById('view-' + tabId).classList.remove('hidden');
            if (tabId === 'dashboard') { loadDashboardData(); loadTrend('today'); loadCronLogs(); }
        }

        function changeAutoRefresh() {
            var val = document.getElementById('auto-refresh-select').value;
            localStorage.setItem('cf_auto_refresh_interval', val);
            applyAutoRefresh(parseInt(val));
        }

        function applyAutoRefresh(ms) {
            if (autoRefreshTimer) clearInterval(autoRefreshTimer);
            if (countdownTimer) clearInterval(countdownTimer);
            document.getElementById('auto-refresh-countdown').classList.add('hidden');

            if (ms > 0) {
                nextRefreshTime = Date.now() + ms;
                document.getElementById('auto-refresh-countdown').classList.remove('hidden');
                updateCountdownText();
                
                countdownTimer = setInterval(() => {
                    updateCountdownText();
                }, 1000);

                autoRefreshTimer = setInterval(() => {
                    if (document.getElementById('view-dashboard').classList.contains('hidden') === false) {
                        loadDashboardData();
                    }
                    nextRefreshTime = Date.now() + ms;
                }, ms);
            }
        }

        function updateCountdownText() {
            var diff = Math.max(0, Math.round((nextRefreshTime - Date.now()) / 1000));
            document.getElementById('auto-refresh-countdown').textContent = '🔄 ' + diff + 's';
        }

        function toggleRow(id) {
            const content = document.getElementById('content-' + id);
            const isO = content.classList.contains('open');
            document.querySelectorAll('.acc-content').forEach(el => el.classList.remove('open'));
            if (!isO) content.classList.add('open');
        }

        function loadDashboardData() {
            apiFetch('./api/usage').then(d => {
                if (!d.success) return;
                document.getElementById('g-total-req').textContent = d.summary.totalRequests.toLocaleString();
                document.getElementById('g-bar').style.width = Math.min(d.summary.percentage, 100) + '%';
                document.getElementById('g-total-rem').textContent = d.summary.totalRemaining.toLocaleString();
                document.getElementById('g-active-count').textContent = d.summary.activeCount;
                if (d.summary.riskCount > 0) {
                    document.getElementById('g-risk').textContent = '有高危请求源';
                    document.getElementById('g-risk').className = 'text-xl font-black text-cf-red mt-1';
                } else {
                    document.getElementById('g-risk').textContent = '负载正常';
                    document.getElementById('g-risk').className = 'text-xl font-black text-cf-green mt-1';
                }
                
                let htmlArr = [];
                d.accounts.forEach(ac => {
                    let dotColor = ac.percentage > 90 ? 'bg-cf-red' : (ac.percentage > 70 ? 'bg-cf-yellow' : 'bg-cf-green');
                    let styleBadge = "";
                    let etaFText = "";
                    let etaAText = "";

                    if (ac.total >= ac.max) {
                        styleBadge = \`<span class="px-2 py-0.5 rounded text-[10px] bg-cf-red/10 text-cf-red border border-cf-red/20 font-bold">🚨 额度耗尽</span>\`;
                        etaFText = \`<span class="text-cf-red font-bold">已超限额额度</span>\`;
                        etaAText = \`<span class="text-cf-red font-bold">已超限额额度</span>\`;
                    } else {
                        let minEta = Math.min(ac.etaFastest > 0 ? ac.etaFastest : 999, ac.etaAvg > 0 ? ac.etaAvg : 999);
                        if (minEta > 24 || minEta === 999) {
                            styleBadge = \`<span class="px-2 py-0.5 rounded text-[10px] bg-cf-green/10 text-cf-green border border-cf-green/20 font-bold">🛡️ 放心使用</span>\`;
                        } else {
                            styleBadge = \`<span class="px-2 py-0.5 rounded text-[10px] bg-cf-yellow/10 text-cf-yellow border border-cf-yellow/20 font-bold">⚠️ 额度吃紧</span>\`;
                        }
                        etaFText = ac.etaFastest > 0 ? ac.etaFastest.toFixed(1) + ' 小时 (按峰值 ' + ac.maxHourlyRate.toLocaleString() + '/h)' : '请求稀少/无忧';
                        etaAText = ac.etaAvg > 0 ? ac.etaAvg.toFixed(1) + ' 小时 (按均速 ' + Math.round(ac.avgHourlyRate).toLocaleString() + '/h)' : '请求稀少/无忧';
                    }

                    const maskedId = ac.accountId ? ac.accountId.slice(0, 4) + '****************' + ac.accountId.slice(-4) : '';
                    const safeName = (ac.name || '').replace(/"/g, '&quot;');

                    htmlArr.push(\`
                    <div class="glass-panel p-4 cursor-pointer hover:border-slate-300 dark:hover:border-slate-500 transition-colors" onclick="toggleRow('\${ac.id}')">
                        <div class="flex flex-col md:flex-row items-center justify-between gap-4">
                            <div class="flex items-center gap-3 w-full md:w-1/3">
                                <div class="w-2.5 h-2.5 rounded-full \${dotColor}"></div>
                                <div class="flex flex-col">
                                    <div class="flex items-center gap-2">
                                        <h4 class="font-bold text-slate-900 dark:text-white text-sm">\${safeName}</h4>
                                        \${styleBadge}
                                    </div>
                                    <span class="text-[10px] text-slate-400 font-mono mt-0.5">\${maskedId}</span>
                                </div>
                            </div>
                            <div class="flex-1 grid grid-cols-4 gap-2 text-center w-full">
                                <div><p class="text-[9px] text-slate-400">今日已产生请求</p><p class="text-sm font-mono text-slate-800 dark:text-white font-bold">\${ac.total.toLocaleString()}</p></div>
                                <div><p class="text-[9px] text-slate-400">安全剩余量</p><p class="text-sm font-mono text-slate-800 dark:text-white">\${Math.max(0, ac.max - ac.total).toLocaleString()}</p></div>
                                <div><p class="text-[9px] text-slate-400">资源占比</p><p class="text-sm font-mono">\${ac.percentage.toFixed(1)}%</p></div>
                                <div><p class="text-[9px] text-slate-400">昨日总结算量</p><p class="text-sm font-mono text-slate-500">\${ac.yesterdayTotal.toLocaleString()}</p></div>
                            </div>
                        </div>
                        <div id="content-\${ac.id}" class="acc-content" onclick="event.stopPropagation()">
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-50 dark:bg-cf-dark p-4 rounded-lg border border-slate-200 dark:border-cf-border">
                                <div>
                                    <p class="text-[10px] text-slate-400 font-bold mb-1">📅 请求流量多维宏观统计</p>
                                    <p class="text-[11px] text-slate-600 dark:text-slate-300 mb-1">昨日总结算点定格流量: <span class="font-mono text-slate-900 dark:text-white">\${ac.yesterdayTotal.toLocaleString()}</span> 次</p>
                                    <p class="text-[11px] text-slate-600 dark:text-slate-300 mb-1">本计费周期内累计总请求次数: <span class="font-mono font-bold text-cf-primary">\${ac.monthTotal.toLocaleString()}</span> 次</p>
                                    <p class="text-[11px] text-slate-600 dark:text-slate-300">备注说明: <span class="italic text-slate-500">\${ac.remark || '暂无备注'}</span></p>
                                </div>
                                <div>
                                    <p class="text-[10px] text-slate-400 font-bold mb-1">⏳ 业务负载衰竭科学演算结论</p>
                                    <p class="text-[11px] text-slate-600 dark:text-slate-300 mb-1">最快衰竭理论临界点: <span class="font-bold text-slate-800 dark:text-white">\${etaFText}</span></p>
                                    <p class="text-[11px] text-slate-600 dark:text-slate-300">均速安全承载期望值: <span class="font-bold text-slate-800 dark:text-white">\${etaAText}</span></p>
                                </div>
                            </div>
                        </div>
                    </div>\`);
                });
                document.getElementById('accounts-list').innerHTML = htmlArr.join('');
            });
        }

        function refreshData() {
            document.getElementById('manual-refresh-btn').textContent = '深度数据采集同步中...';
            apiFetch('./api/refresh', { method: 'POST' }).then(() => { 
                loadDashboardData(); 
                loadTrend('today');
                loadCronLogs();
                document.getElementById('manual-refresh-btn').textContent = '手动强制拉取数据 🔄';
            });
        }

        function loadTrend(period) {
            ['today','yesterday','month'].forEach(id => {
                document.getElementById('p-'+id).className = period === id ? 'px-3 py-1 rounded-md text-[11px] font-semibold bg-white dark:bg-cf-border text-slate-800 dark:text-white shadow-sm' : 'px-3 py-1 rounded-md text-[11px] font-semibold text-slate-500 hover:text-slate-900 dark:hover:text-white';
            });
            apiFetch('./api/trend?period=' + period).then(d => {
                if(d.success && d.trend) renderTrendChart(d.trend, period);
            });
        }

        function renderTrendChart(trendData, period) {
            var container = document.getElementById('chart-container');
            if (trendData.length === 0) { container.innerHTML = '<div class="h-full flex items-center justify-center text-slate-400 text-xs">暂无历史曲线数据...</div>'; return; }
            
            let keys = Object.keys(trendData[0]).filter(k => k !== 'name');
            keys = keys.filter(k => k !== '总计'); 
            keys.push('总计');

            let series = keys.map(k => ({ name: k, data: trendData.map(t => t[k] || 0) }));
            let categories = trendData.map(t => t.name);

            let presetColors = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#0ea5e9', '#ec4899'];
            let colors = keys.map(k => k === '总计' ? '#ef4444' : presetColors.shift() || '#94a3b8');

            if(trendChart) trendChart.destroy();
            trendChart = new ApexCharts(container, {
                series: series,
                chart: { type: 'line', height: '100%', toolbar: { show: false }, background: 'transparent' },
                stroke: { curve: 'smooth', width: keys.map(k => k === '总计' ? 3 : 2), dashArray: keys.map(k => k === '总计' ? 4 : 0) },
                colors: colors,
                xaxis: { categories: categories, labels: { style: { colors: '#64748b', fontSize: '10px' } }, tooltip: {enabled: false} },
                yaxis: { labels: { style: { colors: '#64748b', fontSize: '10px' }, formatter: (val) => val.toLocaleString() } },
                grid: { borderColor: '#e2e8f0', strokeDashArray: 2 },
                theme: { mode: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' },
                legend: { position: 'top', horizontalAlign: 'right', fontSize: '11px', labels: { colors: '#64748b' } }
            });
            trendChart.render();
        }

        function loadCronLogs() {
            apiFetch('./api/cron-log').then(d => {
                if(d.success) {
                    let renderingLogs = d.results ? d.results.slice(0, 5) : (d.logs ? d.logs.slice(0, 5) : []);
                    let html = renderingLogs.map(log => {
                        let dTime = new Date(log.timestamp + 8*3600*1000).toLocaleString();
                        let statColor = log.status === 'success' ? 'text-cf-green' : 'text-cf-red';
                        
                        let textSummary = "";
                        let itemDetailsHtml = [];

                        try {
                            let parsed = JSON.parse(log.message);
                            textSummary = parsed.summaryText || log.message;
                            if (parsed.breakdown) {
                                for(let key in parsed.breakdown) {
                                    itemDetailsHtml.push(\`<span class="inline-block bg-slate-100 dark:bg-cf-border rounded px-1.5 py-0.5 text-[10px] font-mono mr-1 mb-1 text-slate-600 dark:text-slate-300">\${key}: <b class="text-cf-primary">\${parsed.breakdown[key].toLocaleString()}</b></span>\`);
                                }
                            }
                        } catch(e) {
                            textSummary = log.message;
                            itemDetailsHtml.push(\`<span class="text-slate-400 italic">全量兼容旧档模式</span>\`);
                        }

                        return \`
                        <tr class="border-b border-slate-100 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/30">
                            <td class="py-2.5 font-mono text-slate-500">\${dTime}</td>
                            <td class="py-2.5 font-mono">\${log.executionTimeMs} ms</td>
                            <td class="py-2.5 font-mono text-slate-900 dark:text-white font-bold">\${(log.totalRequests||0).toLocaleString()} 次</td>
                            <td class="py-2.5 \${statColor} font-medium">\${textSummary}</td>
                            <td class="py-2.5">\${itemDetailsHtml.join('')}</td>
                        </tr>\`;
                    }).join('');
                    document.getElementById('cron-log-table').innerHTML = html || '<tr><td colspan="5" class="text-center py-4 text-slate-400">暂无精细化日志记录...</td></tr>';
                }
            });
        }

        function loadSettingsData() {
            apiFetch('./api/config').then(d => {
                if(!d.success) return;
                if(d.telegram) {
                    document.getElementById('tg-enabled').checked = d.telegram.enabled || false;
                    document.getElementById('tg-token').value = d.telegram.botToken || '';
                    document.getElementById('tg-chatid').value = d.telegram.chatId || '';
                    document.getElementById('tg-time').value = d.telegram.dailyReportTime || '08:00';
                    document.getElementById('tg-threshold').value = d.telegram.alertThreshold || 90;
                    document.getElementById('tg-surge-alert').checked = d.telegram.surgeAlertEnabled || false;
                }
                
                let tbody = document.getElementById('accounts-config-table');
                tbody.innerHTML = '';
                if(d.accounts && d.accounts.length > 0) {
                    d.accounts.forEach(ac => appendAccountConfigRow(ac));
                } else {
                    addNewAccountRow();
                }
            });
        }

        function appendAccountConfigRow(ac = {}) {
            let tbody = document.getElementById('accounts-config-table');
            let rowId = ac.id || 'ac_' + Math.random().toString(36).substr(2, 9);
            let tr = document.createElement('tr');
            tr.id = 'row_' + rowId;
            tr.className = 'border-b border-slate-100 dark:border-slate-800/40 hover:bg-slate-50/50 dark:hover:bg-slate-800/10';
            
            const safeName = (ac.name || '').replace(/"/g, '&quot;');
            const safeRemark = (ac.remark || '').replace(/"/g, '&quot;');
            const safeGroup = (ac.groupName || 'Default').replace(/"/g, '&quot;');

            tr.innerHTML = \`
                <td class="py-2 pr-2"><input type="text" class="cfg-name w-full bg-slate-50 dark:bg-cf-dark border border-slate-200 dark:border-cf-border rounded p-1.5 font-medium" value="\${safeName}" placeholder="如: 个人主页/反代API"></td>
                <td class="py-2 pr-2"><input type="text" class="cfg-accid w-full bg-slate-50 dark:bg-cf-dark border border-slate-200 dark:border-cf-border rounded p-1.5 font-mono" value="\${ac.accountId || ''}" placeholder="CF 账户 ID"></td>
                <td class="py-2 pr-2"><input type="password" class="cfg-token w-full bg-slate-50 dark:bg-cf-dark border border-slate-200 dark:border-cf-border rounded p-1.5 font-mono" value="\${ac.apiToken || ''}" placeholder="仅修改时填新 Token"></td>
                <td class="py-2 pr-2"><input type="number" class="cfg-limit w-full bg-slate-50 dark:bg-cf-dark border border-slate-200 dark:border-cf-border rounded p-1.5 font-mono" value="\${ac.customLimit || 100000}" placeholder="100000"></td>
                <td class="py-2 pr-2"><input type="text" class="cfg-group w-full bg-slate-50 dark:bg-cf-dark border border-slate-200 dark:border-cf-border rounded p-1.5" value="\${safeGroup}"></td>
                <td class="py-2 pr-2"><input type="text" class="cfg-remark w-full bg-slate-50 dark:bg-cf-dark border border-slate-200 dark:border-cf-border rounded p-1.5" value="\${safeRemark}" placeholder="邮箱或其他备注"></td>
                <td class="py-2 pr-2 text-center"><input type="checkbox" class="cfg-active w-4 h-4 rounded text-cf-primary" \${ac.active !== false ? 'checked' : ''}></td>
                <td class="py-2 text-right"><button onclick="deleteAccountRow('\${rowId}')" class="text-cf-red font-bold hover:underline">删除</button></td>
            \`;
            tbody.appendChild(tr);
        }

        function addNewAccountRow() { appendAccountConfigRow(); }

        function deleteAccountRow(rowId) {
            if(!confirm('确定要同步销毁该请求源及全部流量历史吗？')) return;
            if(!rowId.startsWith('ac_')) {
                apiFetch('./api/config/account/' + rowId, { method: 'DELETE' }).then(res => {
                    if(res.success) { document.getElementById('row_' + rowId).remove(); alert('云端账号数据已成功销毁。'); }
                });
            } else {
                document.getElementById('row_' + rowId).remove();
            }
        }

        function testTelegramChannel() {
            let bt = document.getElementById('tg-token').value;
            let cid = document.getElementById('tg-chatid').value;
            if(!bt || !cid) { alert('请填写完整的 Token 及 ChatID 进行连通测试！'); return; }
            apiFetch('./api/test-telegram', { method: 'POST', body: JSON.stringify({ botToken: bt, chatId: cid }) })
            .then(res => alert(res.message));
        }

        function pushBragReport() {
            apiFetch('./api/push-brag', { method: 'POST' }).then(res => alert(res.message));
        }

        function saveGlobalSettings() {
            let tg = { 
                enabled: document.getElementById('tg-enabled').checked, 
                botToken: document.getElementById('tg-token').value, 
                chatId: document.getElementById('tg-chatid').value, 
                dailyReportTime: document.getElementById('tg-time').value,
                alertThreshold: parseInt(document.getElementById('tg-threshold').value) || 90,
                surgeAlertEnabled: document.getElementById('tg-surge-alert').checked
            };

            let accounts = [];
            let rows = document.getElementById('accounts-config-table').children;
            for(let row of rows) {
                let id = row.id.replace('row_', '');
                if (id.startsWith('ac_')) id = 'prod_' + Math.random().toString(36).substr(2, 9);
                
                let name = row.querySelector('.cfg-name').value;
                let accountId = row.querySelector('.cfg-accid').value;
                if (!name || !accountId) continue; // 自动忽略未填写的空白行

                accounts.push({
                    id: id,
                    name: name,
                    accountId: accountId,
                    apiToken: row.querySelector('.cfg-token').value,
                    customLimit: parseInt(row.querySelector('.cfg-limit').value) || 100000,
                    groupName: row.querySelector('.cfg-group').value,
                    remark: row.querySelector('.cfg-remark').value,
                    active: row.querySelector('.cfg-active').checked
                });
            }

            let payload = { telegram: tg, accounts: accounts };
            apiFetch('./api/config', { method: 'POST', body: JSON.stringify(payload) }).then(res => {
                if(res.success) { alert('✨ 全局大盘配置与账号矩阵保存成功！'); loadSettingsData(); }
                else { alert('配置合并失败: ' + res.message); }
            });
        }

        function initApp() {
            updateLockStateUI();
            var savedInterval = localStorage.getItem('cf_auto_refresh_interval') || '0';
            document.getElementById('auto-refresh-select').value = savedInterval;
            applyAutoRefresh(parseInt(savedInterval));
            switchTab('dashboard');
        }

        window.onload = initApp;
    </script>
</body>
</html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=UTF-8" } });
}
