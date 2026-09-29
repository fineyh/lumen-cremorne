# Lumen — 700 windows, one precinct

> Lighting up a data-dark precinct, one window at a time.

FEIT Hackathon 2026 · Cremorne Digital Hub 题目的可运行原型。三层结构 **Sense → Understand → Act** 全部在本机运行，不依赖任何云 API。

| 层 | 原型里有什么 | 代码 |
| --- | --- | --- |
| **Sense** | Window Node 计数脚本（YOLOv8n + ByteTrack / OpenCV 运动检测 / 模拟 / 键盘手动计数），只上报数字；OSM 建筑 2,835 栋、Yarra 市政行道树 + OSM 树 2,180 棵、153 km 人行路网、火车站和电车站 | `node/window_node.py`、`data/fetch_osm.py` |
| **Understand** | 阴影模型（NOAA 太阳位置 + 建筑扫掠阴影 + 树冠阴影，每段路取较阴一侧）；人流模型（列车到站脉冲 + Fruin LOS） | `backend/lumen/shade.py`、`crowd.py` |
| **Act** | Shade Router 三档路线；Morning Brief（Slack 样式）+ Ask Lumen 问答；Precinct Console（Hub 视图 / 租户视图 / CSV 周报）；离线评估 | `router.py`、`brief.py`、`evaluate.py`、`frontend/` |

## 快速启动

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

## 演示脚本（按 Mia 的一天，约 4 分钟）

| 时间 | 操作 | 要讲的点 |
| --- | --- | --- |
| 开场 | 讲台上放节点，评委走过，右上角计数跳动 | 700 个租户就是 700 个传感器。节点只发数字，服务端拒收任何其他字段（带 `image` 字段的请求直接 422） |
| 8:15 | **Brief** 标签：Slack 里的 Morning Brief | 数字全部来自后端，LLM 在本机运行 |
| 8:45 | 时间轴点「8:45 rush」，图层切「Crowding」 | Richmond 站出来的 Swan St / Cremorne St 在列车到站后达到 LOS D。Least crowded 路线多走 0.8 分钟，拥挤步行时间从 3.0 分钟降到 0.2 分钟（Richmond → Dover House） |
| 12:30 | Ask Lumen：“Where's quiet for lunch?” | 用 tool calling 查询人流模型 |
| 15:30 | 时间轴点「3:30 heat」，打开 3D，按 ▶ 播放 | 阴影随太阳流动，路线跟着变。Richmond → Era Building：多走 1.2 分钟，少晒 6.8 分钟 |
| 全天 | **Precinct → Tenant view** | 咖啡馆老板看自家门口每小时人流，用来排班 |
| 每周 | **Precinct → Hub view → Download CSV** | 哪些路段长期过挤、最晒，作为向市议会要树荫的证据 |
| 收尾 | **Impact** 标签，然后 **Limits** 标签 | 可复现的离线评估；主动讲清 who it does not serve |

### 离线评估结果（`python -m lumen.evaluate`，在 `backend/` 下运行）

从 4 个站点到 76 栋工作楼，共 304 条行程：

| 场景 | 最凉路线少晒（中位数） | 中位绕路 | 改善的行程 |
| --- | --- | --- | --- |
| 热天 35°C · 15:30 | **−41%**（中位数少晒 1.8 分钟） | 0.5 分钟 | 80% |
| 热天 · 8:45（26.9°C） | −46%（中位数少晒 2.1 分钟） | 0.2 分钟 | 87% |
| 凉爽对照日 21°C · 15:30 | 0%（不绕路，符合设计） | 0 | 0% |

拥挤方面：热天 8:45 有 94 条行程会经过 LOS D 及以上路段。Least crowded 路线把这部分拥挤步行时间的中位数降低 93%，中位绕路 0.8 分钟。

## 哪些是真的，哪些是模拟的（pitch 时如实说）

| 真实 / 实测 | 模型 / 估算 | 合成（界面上已标注） |
| --- | --- | --- |
| OSM 建筑轮廓、路网、车站 | 缺失的建筑高度：楼层数 × 3.5 m，否则按建筑类型给默认值 | 12 个 “replayed” 节点的读数由人流模型生成 |
| City of Yarra 行道树（含胸径） | 树冠半径由胸径估算 | 10,000 名员工在各站点的分配比例 |
| 太阳位置（NOAA 算法） | 人行道宽度：按街道等级赋值，主路手工校正 | 列车班距为静态近似（GTFS-R 接口待接入） |
| node-00 现场计数 | LOS：峰值分钟流量 ÷ 有效宽度 | 热天场景的气温曲线 |

## 目录

```
data/fetch_osm.py        下载 OSM 数据（已缓存在 data/raw/）
backend/server.py        FastAPI：API + 静态前端 + SSE 实时推送
backend/lumen/           geo / sun / precinct / shade / crowd / router / engine / evaluate / brief / live
node/window_node.py      Window Node 演示版
frontend/                Vite + React + MapLibre GL
```

## API 速查

`GET /api/state?scenario=hot&t=525` · `GET /api/shadows?...` · `GET /api/route?from=train-richmond&to=<office id>&t=930` · `GET /api/evaluation` · `GET /api/brief?office=` · `POST /api/ask` · `POST /api/live/ingest` · `GET /api/live/stream` · `GET /api/report.csv`
