# Lumen — 700 windows, one precinct

> Lighting up a data-dark precinct, one window at a time.

Lumen 是一个面向墨尔本 Cremorne 片区的步行舒适度原型：用租户窗边的计数节点感知人流，结合阴影和人流模型，为通勤者推荐更凉、更不挤的步行路线，并为片区管理方和市议会提供 What-if 情景模拟。

FEIT Hackathon 2026 · Cremorne Digital Hub 题目的可运行原型。三层结构 **Sense → Understand → Act** 全部在本机运行，不依赖任何云 API。

| 层 | 原型里有什么 | 代码 |
| --- | --- | --- |
| **Sense** | Window Node 计数脚本（YOLOv8n + ByteTrack / OpenCV 运动检测 / 模拟 / 键盘手动计数），只上报数字；OSM 建筑 2,835 栋、Yarra 市政行道树 + OSM 树 2,180 棵、153 km 人行路网、火车站和电车站 | `node/window_node.py`、`data/fetch_osm.py` |
| **Understand** | 阴影模型（NOAA 太阳位置 + 建筑扫掠阴影 + 树冠阴影，每段路取较阴一侧）；人流模型（列车到站脉冲 + Fruin LOS） | `backend/lumen/shade.py`、`crowd.py` |
| **Act** | Shade Router 三档路线 + Comfort Score；Morning Brief（Slack 样式）+ Ask Lumen 问答；Precinct Console（Hub / 租户视图、CSV 周报、**What-if 情景模拟**）；**手机端 PWA**（上班族 / 司机 / 商户 / CDH，含模拟短信）；离线评估 | `router.py`、`whatif.py`、`personal.py`、`sms.py`、`brief.py`、`evaluate.py`、`frontend/` |

两个入口，同一个服务：

- **Console**（http://localhost:8000）：给 CDH 和市议会，完整地图、What-if、周报。
- **手机端**（http://localhost:8000/m）：给普通用户，只显示和自己有关的一两件事。免登录，设置只存在手机上。Console 右上角 **Phone app** 按钮会给出局域网二维码。

## 快速启动

环境要求：Python 3.10+、Node.js 20.19+（Vite 8 的最低要求）。命令以 PowerShell 为例，macOS / Linux 下把 `;` 换成 `&&` 即可。

```powershell
# 1. 后端依赖（一次）
pip install -r backend/requirements.txt

# 2. 前端构建（一次；改了前端代码才需要重跑）
cd frontend; npm install; npm run build; cd ..

# 3. 启动（同时提供 API 和网页）
python backend/server.py
```

打开 http://localhost:8000 。也可以直接运行 `start.ps1`。

> 首次启动时，后台会预计算评估结果和整天的阴影帧，并缓存到 `data/cache/`。第一次大约需要 2 分钟，之后秒开。**演示前先跑一次。**

### 现场节点

```powershell
pip install -r node/requirements.txt
python node/window_node.py --mode motion --show      # 摄像头 + 运动检测（轻量）
pip install ultralytics                              # 可选，约 1 GB（含 PyTorch）
python node/window_node.py --mode yolo --show        # 摄像头 + YOLOv8n + ByteTrack
python node/window_node.py --mode simulate --rate 30 # 没有摄像头时用于排练
python node/window_node.py --mode keyboard           # 手动计数，也可用于准确率测试
```

地图右上角的计数卡片和 Cremorne St 上的红点会实时跳动。要走 MQTT，就用 `--mqtt localhost` 启动节点，服务端设置 `LUMEN_MQTT=localhost`，并安装 `paho-mqtt`。

### 本地 LLM（可选）

安装 [Ollama](https://ollama.com) 后运行 `ollama pull qwen2.5:7b`。服务端会自动检测，用它润色 Morning Brief，并为 Ask Lumen 做 tool calling。

- LLM 只改写措辞。输出里只要有任何数字和后端给出的不一致，就退回确定性模板。
- 没装 Ollama 时，Brief 用模板生成，Ask Lumen 用规则路由，功能完整。
- 换模型：设置 `LUMEN_MODEL=llama3.1:8b`。

### 前端开发模式

```powershell
python backend/server.py          # 终端 1
cd frontend; npm run dev           # 终端 2 → http://localhost:5173（/api 代理到 8000）
```

## What-if 情景模拟（Console → What-if）

在地图上改一个因素，马上看到对整片区 304 条“车站 → 办公楼”步行的影响。基础数据从不修改，情景是叠在上面的一层。

| 工具 | 做什么 | 12 个月内能落地？ | 参考造价（A$，含安装） |
| --- | --- | --- | --- |
| 种树（S / M / L） | 圆形树冠，和现有行道树走同一套阴影计算 | 否：满冠约 15 年，用“成熟度”滑块看第 1 年和第 15 年 | 1.2k–2k / 2k–3.5k / 3.5k–6k |
| 遮阳帆 6 × 6 m | 离地 4 m 的矩形，沿最近街道方向摆放 | 是 | 8k–15k |
| 雨棚 12 m | 离地 3.2 m，贴着店面 | 是 | 15k–30k |
| 移除树木 | 点现有树冠 | 是 | 1.5k–4k |
| 路段施工关闭 | 点人行道，关闭到最近两个路口之间的整段 | 是 | 1.5k–3k / 天（交通管理） |

- **自动重算**：只重测新增或移除阴影内的采样点，只重新描述最佳路径经过变化路段的起终点组合（通常 20–60 / 304 条），约 0.1–0.5 秒。
- **前后对比**：常走路线的暴晒分钟数（前 → 后）、受益路线数、Comfort Score、有阴影一侧的路径占比、为避晒要绕的路（Lumen 最凉路线）、关闭造成的绕行。地图上绿色是阴影变多的路段，红色是变少的，红色虚线是关闭的路段，深绿色是新增阴影。
- **造价**：总造价区间、分项、“每改善一条路线的造价”、12 个月内可交付的部分。数字是规划用的参考区间，不是报价；在人行道上新开树坑（加结构土）会贵好几倍。
- **情景保存**：命名保存到 `data/whatif/`，勾选多个做并排对比，导出 CSV（三种天气场景的前后对比、每项干预和造价、受影响的行程），作为给市议会的材料。
- 界面上所有结果都标着 **Model estimate**。

**Comfort Score**（0–100，每段路，按长度加权到路线或整个片区）：`100 − 60 × 晒到的比例 × min(H, 1) − 40 × min(LOS 惩罚, 2) / 2`，其中 H = max(0, (T − 24) / 10)。完全暴晒且 34°C 以上扣 60 分，LOS E 及以上扣 40 分。

离线脚本可以对任一情景重跑（只算受影响的起终点组合）：

```powershell
cd backend
python -m lumen.evaluate --plan <已保存的情景 id 或 JSON 文件>
```

## 手机端（/m）

注册时只问角色和几个地点，存在手机本地（localStorage），不建账号，不要位置。每次请求只带地点 id，用完即丢。

| 角色 | 首页 | 推荐（规则由后端生成） |
| --- | --- | --- |
| 上班族 | **今日卡片**：几点从车站出发、走哪条路，“比最短路少晒 X 分钟、少挤 Y 分钟、多走 Z 分钟”，小地图 + 逐段提示 | 午饭时附近哪条街人少、几点前后避开高峰；热天去别的楼开会走哪条最凉 |
| 送货司机 | 自己常送的几条街全天拥挤色带、忙碌时段 | 避开列车到站高峰的卸货时间窗；整条线路共同的最佳时段；同样内容的短信版本 |
| 商户 | 门口每小时人流，与上周同日对比 | 加人排班时段、是否提早开门 / 晚点关门、空闲时段 |
| CDH / 市议会 | 片区 Comfort Score、过挤和最晒的街 | 打开完整 Console（含 What-if）、下载周报 CSV |

- **推荐逻辑**：用户设置 + 当天气温 + 人流模型 → 后端规则算出推荐和所有数字。本地 LLM（如果有）只负责润色文字，改动任何数字就退回模板，和 Brief 同一套检查。
- **短信只给司机**：手机上模拟完整对话（JOIN → 选街道 → 每天 6:30 一条；TODAY / CHANGE / STOP / HELP）。只有主动发 JOIN 才会收到消息，只存所选街道，不存号码和位置，STOP 即删除。短信内容只用 GSM-7 字符（一条最多 160 字）。
- **主权**：常见短信服务（如 Twilio）在海外。Demo 不真发短信；量产时换成澳洲本地托管的短信网关，短信里只放公开的街道级信息。
- **形式**：PWA（manifest + service worker，可“添加到主屏幕”）。原方案写的是 Next.js；原型继续用现有的 Vite + React，在同一个前端里加 `/m` 路由，这样仍然由 FastAPI 单进程离线提供全部服务，不用额外跑 Node 服务端。

## 演示流程（以虚构通勤者 Mia 的一天为例，约 4 分钟）

| 时间 | 操作 | 看点 |
| --- | --- | --- |
| 开场 | 讲台上放节点，评委走过，右上角计数跳动 | 700 个租户就是 700 个传感器。节点只发数字，服务端拒收任何其他字段（带 `image` 字段的请求直接 422） |
| 8:15 | **Brief** 标签：Slack 里的 Morning Brief | 数字全部来自后端，LLM 在本机运行 |
| 8:45 | 时间轴点「8:45 rush」，图层切「Crowding」 | Richmond 站出来的 Swan St / Cremorne St 在列车到站后达到 LOS D。Least crowded 路线多走 0.8 分钟，拥挤步行时间从 3.0 分钟降到 0.2 分钟（Richmond → Dover House） |
| 12:30 | Ask Lumen：“Where's quiet for lunch?” | 用 tool calling 查询人流模型 |
| 15:30 | 时间轴点「3:30 heat」，打开 3D，按 ▶ 播放 | 阴影随太阳流动，路线跟着变。Richmond → Era Building：多走 1.2 分钟，少晒 6.8 分钟 |
| 全天 | **Precinct → Tenant view** | 咖啡馆老板看自家门口每小时人流，用来排班 |
| 每周 | **Precinct → Hub view → Download CSV** | 哪些路段长期过挤、最晒，作为向市议会要树荫的证据 |
| 市议会 | **What-if**：3:30 heat，沿 Cremorne St 种 5 棵大树，成熟度拉到 15 年 → 再拉回第 1 年 → 换成遮阳帆 | “向市议会要树荫”变成可算的证据：暴晒分钟数前后对比、受益路线数、造价。第 1 年几乎没效果，这正是为什么 12 个月内要用遮阳帆 |
| 市议会 | 保存两个情景 → 并排对比 → Council CSV | 直接可交给市议会的材料，全部标注“模型估计” |
| 手机 | 扫 Console 的二维码 → 选“上班族” | 今日卡片：几点出发、走哪条路、少晒几分钟 |
| 手机 | 切到“司机” → Texts → JOIN → `1 6` | 不装 App 的人也被覆盖了；短信通道在 Demo 里模拟，量产换本地网关 |
| 收尾 | **Impact** 标签，然后 **Limits** 标签 | 可复现的离线评估；主动讲清 who it does not serve（送货司机、商户、一线员工现在已被覆盖，页面上标了 covered / partly / not yet） |

### 离线评估结果（`python -m lumen.evaluate`，在 `backend/` 下运行）

从 4 个站点到 76 栋工作楼，共 304 条行程：

| 场景 | 最凉路线少晒（中位数） | 中位绕路 | 改善的行程 |
| --- | --- | --- | --- |
| 热天 35°C · 15:30 | **−41%**（中位数少晒 1.8 分钟） | 0.5 分钟 | 80% |
| 热天 · 8:45（26.9°C） | −46%（中位数少晒 2.1 分钟） | 0.2 分钟 | 87% |
| 凉爽对照日 21°C · 15:30 | 0%（不绕路，符合设计） | 0 | 0% |

拥挤方面：热天 8:45 有 94 条行程会经过 LOS D 及以上路段。Least crowded 路线把这部分拥挤步行时间的中位数降低 93%，中位绕路 0.8 分钟。

## 哪些是真实数据，哪些是模型 / 模拟

| 真实 / 实测 | 模型 / 估算 | 合成（界面上已标注） |
| --- | --- | --- |
| OSM 建筑轮廓、路网、车站 | 缺失的建筑高度：楼层数 × 3.5 m，否则按建筑类型给默认值 | 12 个 “replayed” 节点的读数由人流模型生成 |
| City of Yarra 行道树（含胸径） | 树冠半径由胸径估算；新种树的生长曲线（15 年满冠） | 10,000 名员工在各站点的分配比例 |
| 太阳位置（NOAA 算法） | 人行道宽度：按街道等级赋值，主路手工校正 | 列车班距为静态近似（GTFS-R 接口待接入） |
| node-00 现场计数 | LOS：峰值分钟流量 ÷ 有效宽度 | 热天场景的气温曲线 |
| | What-if 的全部结果；造价区间（规划参考，不是报价） | 商户“上周同日”对比（回放数据） |
| | Comfort Score 的权重 | 短信对话（手机上模拟，不真发送） |

## 目录

```
data/fetch_osm.py        下载 OSM 数据（已缓存在 data/raw/）
backend/server.py        FastAPI：API + 静态前端 + SSE 实时推送
backend/lumen/           geo / sun / precinct / shade / crowd / router / engine / evaluate / brief / live
                         whatif（情景叠加层、前后对比、造价、保存）
                         personal（手机端各角色首页和推荐）· sms（模拟短信通道）
data/whatif/             已保存的情景（不入库）
node/window_node.py      Window Node 演示版
frontend/                Vite + React + MapLibre GL；/ 是 Console，/m 是手机端 PWA（src/mobile/）
```

## API 速查

`GET /api/state?scenario=hot&t=525` · `GET /api/shadows?...` · `GET /api/route?from=train-richmond&to=<office id>&t=930` · `GET /api/evaluation` · `GET /api/brief?office=` · `POST /api/ask` · `POST /api/live/ingest` · `GET /api/live/stream` · `GET /api/report.csv`

What-if：`POST /api/whatif/compare`（`{items, years, scenario, t}` → 情景 key + 前后对比；之后 `/api/state`、`/api/route` 可带 `&plan=<key>`）· `GET/POST /api/whatif/plans` · `DELETE /api/whatif/plans/{id}` · `GET /api/whatif/side-by-side?ids=` · `GET /api/whatif/export.csv?ids=`（`POST` 导出未保存的草稿）

手机端：`GET /api/me/commuter?stop=&office=&arrive=09:00` · `GET /api/me/driver?streets=Swan Street,Cremorne Street` · `GET /api/me/merchant?node=node-03&open=07:00&close=16:00` · `GET /api/me/council` · `POST /api/sms`（`{session, text}`，模拟短信网关）

## 数据来源与许可

- 建筑、路网、车站、部分树木：© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors，[ODbL](https://opendatacommons.org/licenses/odbl/) 许可。`data/raw/` 下缓存的是 Overpass API 导出的数据，可用 `python data/fetch_osm.py` 重新下载。
- 行道树：City of Yarra 开放数据（street tree inventory），使用时请遵守其开放数据许可并注明来源。
- 地图渲染：[MapLibre GL JS](https://maplibre.org/)。
