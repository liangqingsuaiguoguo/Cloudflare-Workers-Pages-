# Cloudflare Workers & Pages 专业多账号监控中心 (CF Monitor Pro V3.0)
## 部署与使用全指引手册

本系统基于强大的 **Cloudflare Workers** 架构，无缝融合 **Cloudflare D1 分布式关系型数据库** 与 **Telegram Bot API 高级联动链路**，为您打造一个具备高度持久化、全时自动化、极致安全合规的多账号流量观测大盘。

---

### 一、 🚀 快速部署与初始化指南

为了让您以最快速度上线监控中心，请按以下精简流程快速配置。

#### 步骤 1：创建 Cloudflare D1 关系型数据库并初始化
本系统完全依赖 D1 存储数据，必须最先创建并进行初始化建表。
1. 登录 Cloudflare 控制台。
2. 点击左侧菜单的 "存储与数据库" (Storage & Databases) → "D1"。
3. 点击 "创建" (Create) → "创建数据库" (Create database)。
4. 在数据库名称中输入：cf_monitor_db（或自定义名称），点击 "创建"。
5. 成功后，记录页面中显示的 "数据库 ID" (Database ID)。
6. 执行数据库初始化：留在当前 D1 数据库页面，点击 "控制台" (Console) 或 "SQL" 选项卡，复制以下 SQL 脚本并点击 "运行" (Execute) 执行，即可秒级建立监控所需的所有持久化数据表：

CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    accountId TEXT NOT NULL,
    apiToken TEXT NOT NULL,
    customLimit INTEGER DEFAULT 100000,
    active INTEGER DEFAULT 1,
    lastChecked INTEGER
);

CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL,
    accountName TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    workersRequests INTEGER NOT NULL,
    pagesRequests INTEGER NOT NULL,
    totalRequests INTEGER NOT NULL,
    limitRequests INTEGER NOT NULL,
    cpuTime REAL DEFAULT 0,
    kvReads INTEGER DEFAULT 0,
    kvWrites INTEGER DEFAULT 0,
    cronStatus TEXT DEFAULT 'success',
    apiStatus TEXT DEFAULT 'success'
);

#### 步骤 2：创建 Worker 实例并粘贴代码
1. 点击左侧菜单的 "Workers 和 Pages" (Workers & Pages) → "概述" (Overview)。
2. 点击 "创建" (Create) → "创建 Worker" (Create Worker)。
3. 命名为 cf-monitor-pro（或自定义名称），点击 "部署" (Deploy)。
4. 部署完成后，点击 "编辑代码" (Edit code)。
5. 将本项目的 worker.js 全部源代码 覆盖粘贴进去。

#### 步骤 3：绑定 D1 数据库变量
1. 退出代码编辑器，回到该 Worker 的管理主界面。
2. 切换到 "设置" (Settings) 选项卡，在左侧选择 "绑定" (Bindings)。
3. 点击 "添加" (Add) → 选择 "D1 数据库" (D1 database)。
4. 务必严格配置：
   * 变量名称 (Variable name)：必须填写大写 DB（代码中通过 env.DB 调度）。
   * D1 数据库：下拉菜单选择您在步骤1中创建的数据库（如 cf_monitor_db）。
5. 点击 "部署" (Deploy) 保存绑定。

#### 步骤 4：配置自动化采集定时触发器 (Cron Triggers)
系统通过此触发器自动洗刷并拉取 GraphQL 流量数据。
1. 在 Worker 的 "设置" (Settings) 选项卡中，选择左侧菜单的 "触发器" (Triggers)。
2. 滚动至 "定时触发器" (Cron Triggers)，点击 "添加定时触发器" (Add Cron Trigger)。
3. 填入 Cron 表达式：*/10 * * * *（每 10 分钟执行一次，强烈推荐）。
4. 点击 "添加" 保存。

#### 步骤 5：大盘强制密码初始化
1. 访问 Cloudflare 分配的 Worker 默认域名路由。
2. 系统在初次启动时，会检测到管理员处于默认空密码状态，大盘前端将强制弹出 “🚨 强制初始化管理密码” 强冲突窗口。
3. 设定您的复杂专属密码并保存，即可完成权限交割，进入监控大盘！

---

### 二、 🔑 密码忘记与重置教程

如果您不慎遗忘了监控中心大盘的登录密码，由于密码安全托管在 D1 数据库中，您可以通过在 Cloudflare 后台执行 SQL 控制台命令来强行重置：

1. 进入 Cloudflare 控制台，点击左侧菜单的 "存储与数据库" (Storage & Databases) → "D1"。
2. 点击进入您为本项目绑定的数据库（例如 cf_monitor_db）。
3. 切换到 "控制台" (Console) 选项卡。
4. 在 SQL 输入框中执行以下清空密码命令，将其恢复至未初始化状态：
   UPDATE config SET value = '' WHERE key = 'password';
5. 点击 "运行" (Execute)。执行成功后，重新刷新您的监控大盘网页，系统将再次弹出 “🚨 强制初始化管理密码” 窗口，您可以重新设定全新的安全密码。

---

### 三、 核心功能模块深度解析

本控制面板旨在消除由于多账号管理带来的信息孤岛，通过深度科学演算，提供全链路的数据洞察。

#### 1. 双色自适应数据大盘 (Web UI)
* 时空透视流量画布：嵌入高度定制化的 ApexCharts 动态图表，支持“今日24小时”、“昨日24小时”与“本月累计报告”的多维宏观流向透视。
* 业务请求状态矩阵：清晰展示每个独立请求源的单日并发量、安全剩余量与资源占比，并采用绿/黄/红三色水波纹对负载状态进行实时评估。
* 科学衰竭深度预测：基于边缘算力，实时捕获小时内最大峰值增量与均速消耗，动态演算出“最快衰竭理论临界点（ETA Fastest）”与“均速安全承载期望值（ETA Avg）”，助您在额度耗尽前提前介入。

#### 2. 基于 D1 数据库的高度保密前端密码锁
* 无状态动态密钥验证：后台摒弃了脆弱的传统硬编码密码，其访问权限及加密认证完全托管在 Cloudflare D1 关系型数据库中。
* 零配置强制初始化规范：系统初次启动时，若检测到管理员仍使用默认密码（admin），大盘将启用拦截机制，激活强冲突弹窗，强制要求配置高强度复杂口令后方可登入。
* 前端轻量级防泄露：敏感数据提交、修改或进入“业务配置中心”时，必须经过 D1 密码鉴权。而只读查询接口则支持安全放行，便于在公共监控设备上全天候常亮展示。

#### 3. Telegram 自动化告警风控通道
* 毫秒级分布式边缘推送：依靠 Cloudflare 全球边缘网络，当特定账号流量触及瓶颈时，Worker 会在毫秒内直连 Telegram API。
* 多维度连通性测试：在业务配置中心内，提供了“⚡ 测试通道连通”一键测试组件，支持在应用上线前校验 Bot Token 及 Chat ID 的合规性。

#### 4. TG 每日精准对账日报
* 定时聚合对账模型：监控中心每日在预设时间（例如北京时间 08:00）触发全局审计。
* 全量数据格式化下发：自动清算过去24小时周期内的流量消耗，将各节点明细（脱敏展示 ID）及“全栈汇总信息”（总消耗、剩余总配额、整体使用率）组合为完美的 Markdown 报文下发至您的专属频道。

#### 5. 瞬时高并发激增告警机制
* 滑动时间窗口差分算法：每次定时触发器（Cron Trigger）执行时，系统自动调取该账号30分钟前的历史快照，并与当前瞬时用量进行差分计算。
* 突发流量风控红线：若在30分钟的衰减周期内，单一请求源的绝对差值激增突破 10,000次，系统将立即跨过普通阈值，拉响 🚨 突发流量暴增告警。
* 30分钟智能冷却锁：引入 alerts_log 冷却阻断，避免在遭受恶意 CC 攻击或遭遇高并发激增时，因频繁调用 Telegram API 而被官方实施速率限制（Rate Limiting）。

#### 6. TG 一键推流（装13）能效战报
* 瞬时战报动态生成：在业务配置中心内置了“🚀 一键推流简报”战略组件。
* 集群能效数据降维：点击后，系统自动完成内存计算，统计出当前集群的“总吞吐请求”、“最高能耗节点（MVP）”、“最闲置温和节点”以及“平均节点负载水位”，生成极极具视觉冲击力的集群能效战报进行一键推送。

#### 7. 核心控制矩阵自定义设置
* 网格化热插拔控制台：支持对多账号进行无缝增删改查。提供自定义别名、安全额度上限划分、业务分组归类（Group）、邮箱及用途备注说明等精细化配置。
* Token 前端脱敏保护：从 D1 数据库回显的 API Token 均在边缘侧执行截断脱敏（仅显示前4位与后4位，中间以 * 屏蔽），确保管理员在演示或屏幕共享时，核心资产不会发生物理泄露。

---

### 四、 核心凭证：Account ID & API Token 获取方法

为了保证系统能够通过 GraphQL API 精准采集您的 Workers 和 Pages 用量，您需要提供 Cloudflare 的账户凭证。以下为最标准、最安全的获取路径：

#### 1. 获取 Account ID (账户 ID)
1. 登录 Cloudflare 控制台。
2. 在左侧主导航栏中，点击 "Workers 和 Pages" (Workers & Pages)。
3. 进入该页面后，在屏幕右侧的侧边栏（或下拉至页面底部）可以找到 "账户 ID" (Account ID) 区域。
4. 点击复制该 32 位的十六进制字符串即可。

#### 2. 创建高度安全的 API Token (API 令牌)
为了遵循最小权限原则，切勿使用您的“全局 API 密钥 (Global API Key)”。请按照以下步骤创建专属令牌：
1. 在 Cloudflare 控制台右上角，点击您的 "用户头像"，选择 "我的个人资料" (My Profile)。
2. 在左侧菜单中点击 "API 令牌" (API Tokens)，随后点击 "创建令牌" (Create Token)。
3. 找到页面底部的 "创建自定义令牌" (Create Custom Token) 选项，点击 "开始使用"。
4. 进行如下精准配置（权限不满足会导致数据拉取失败/返回 403）：
   * 令牌名称：建议命名为 CF-Monitor-Pro-Token。
   * 权限设置 (Permissions)：
     * 账户 (Account) → Workers Analytics → 读取 (Read)
     * 账户 (Account) → Cloudflare Pages → 读取 (Read)
   * 账户资源 (Account Resources)：选择 所有账户 或指定您包含上述 Account ID 的特定账户。
   * TTL / TTL 限制：保持默认（永久有效），或根据您的安全合规需求设置过期时间。
5. 点击 "继续以显示摘要"，确认无误后点击 "创建令牌" 并复制生成的 API Token。

---

### 五、 致谢致敬界面

本项目的完美落地离不开开源技术社区的深厚底蕴与人工智能的敏捷辅助，在此致以最诚挚的谢意：

* 感谢开源卓越贡献者：
  感谢 CM大佬 的卓越源项目 CF-Workers-UsagePanel。本项目所有核心逻辑与高级改造均基于大佬的开源代码衍生演进。开源薪火相传，如果您觉得本面板对您的算力管理有所裨益，请务必前往大佬的原项目主页点亮 ✨ Star (明星)，向先驱者致敬！
* 感谢人工智能敏捷算力支持：
  * 感谢 Gemini（免费版） 极其出色的代码分析、逻辑重构与架构优化能力。它帮我深度剖析了 GraphQL 通信机理，并一步步完善、修改、攻克了 D1 关系型存储架构的平滑平移，让系统在面对高并发大吞吐时稳如磐石。
  * 感谢 ChatGPT（免费版） 帮我打磨并输出了如此详尽、优美的工程级 README 大盘界面、详实通俗的全局部署流程，使得即使是初学者也能无痛上手，享受到边缘算力带来的工业级监控快感。
