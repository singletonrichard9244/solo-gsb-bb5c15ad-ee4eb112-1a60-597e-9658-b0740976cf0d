# 🎭 剧场排练 · 多人时序编排（Rehearsal Timeline）

面向剧场排练的**多人实时时间线协作** Web 应用：导演、场记、音效在同一剧目中
拖拽编排 **场次 → 动作** 与 **音效** 的时间轴。基于操作日志（Operation Log）+
**Lamport 时钟** + **版本向量**，支持离线编辑、断线重连合并与确定性冲突解决，
所有客户端最终收敛到完全一致的顺序。

- 后端：Python 3.11 · FastAPI · WebSocket · SQLite（`aiosqlite`，WAL）
- 前端：原生 HTML / CSS / ES Modules（零构建、零前端框架）
- 同步：每条编辑生成携带 Lamport 时钟与版本向量的不可变操作日志
- 合并：纯函数 fold，Python（`app/engine.py`）与浏览器（`static/engine.js`）双端实现、语义一致

---

## 一键启动（Docker Compose）

```bash
docker compose up -d --build
```

打开浏览器访问：

- **应用界面**：<http://localhost:8000/>
- API 文档（FastAPI 自动生成）：<http://localhost:8000/docs>
- 健康检查：<http://localhost:8000/api/health>

| 端口 | 用途 |
| ---- | ---- |
| `8000` | HTTP 静态页面 + REST API + WebSocket（同一端口，路径分别为 `/`、`/api/*`、`/ws/{playId}`） |

SQLite 数据文件持久化在 Docker 卷 `rehearsal-data`（容器内 `/data/rehearsal.db`）。
停止与清理：

```bash
docker compose down          # 停止（保留数据）
docker compose down -v       # 停止并删除数据卷
```

### 本地直接运行（无 Docker）

```bash
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
# 数据库路径可用环境变量覆盖：REHEARSAL_DB=/tmp/rt.db uvicorn ...
```

---

## 使用说明

1. 打开页面后输入昵称，**新建剧目**或从列表选择已有剧目（同一剧目标题即协作房间）。
2. 顶部工具栏：
   - **＋ 场次**：在时间线末尾新建场次；
   - **＋ 音效**：新建独立音效块；
   - 场次轨道上的 **＋**：为该场次添加动作；
   - **导出 / 导入 JSON**：完整操作日志级别的备份与迁移。
3. **拖拽**：按住任意块横向拖动调整开始时间（自动吸附 250 ms），也可在右侧
   「属性」面板中精确编辑名称、开始时间（支持 `1:02.500` 或纯毫秒 `62500`）、
   时长，动作还可切换所属场次。
4. 右上角显示**在线成员**（颜色按客户端 ID 稳定生成）与连接状态；断线时状态栏
   显示「离线 · 缓冲 N 条操作」，重连后自动补传。
5. 右侧「冲突」标签列出所有并发冲突（带红色徽标计数），时间线上对应元素显示
   红色「冲突」角标；「操作日志」标签可查看带 Lamport 时间戳的完整历史。
6. 删除的元素进入时间线底部 **🗑 回收站**，可点击恢复（并发删除的元素也保留在
   那里，不会静默丢失）。
7. 右侧 **📋 提示单** 标签（或选中场次后属性面板中的「📋 场次提示单」）生成
   **只读**场次提示单：按时间线稳定顺序 `(开始时间, createKey)` 列出在该场次
   **半开区间 `[起点, 终点)`** 内开始的可见动作与音效，显示相对场次起点的时间、
   名称、时长。恰好在边界上的提示只归入一个场次；可见性与折叠视图一致（已删除
   元素、所属场次被删而隐藏的动作均不出现）。提示单不产生任何协作操作，可用
   「🖨 打印 / 另存 PDF」或浏览器 Ctrl+P 打印（自带打印样式，只输出提示单）。

### 多人协作同一房间

把剧目页面链接（形如 `http://localhost:8000/#/play/ab12cd34ef56`）发给其他成员，
各自用不同昵称打开即进入同一房间；浏览器会记住身份（localStorage）。

---

## 一致性模型

### 操作结构

每次编辑追加一条不可变操作：

```jsonc
{
  "opId":    "17@c_a1b2c3",          // <本客户端单调序号>@<客户端ID>
  "type":    "add|move|rename|delete|restore",
  "kind":    "scene|action|sound",
  "elemId":  "e_xxxx",
  "lamport": 42,                     // 发出时的 Lamport 时钟
  "clientId":"c_a1b2c3",
  "vv":      { "c_a1b2c3": 16 },     // 发出时的版本向量（因果上下文）
  "payload": { "start": 12500 },     // 依类型而定
  "parent":  "e_sceneId"             // add/move 动作时的所属场次
}
```

- **Lamport 时钟**：`L = max(本地L, 所有已知操作L) + 1`；收到远程操作取 `max`。
- **版本向量（VV）**：每个客户端维护 `{客户端ID: 已见该客户端最大序号}`。
- **happens-before**：当 `B.vv[A.clientId] ≥ A.seq` 时 A 因果先于 B（`A → B`）。

### 断线队列与重连合并

1. 断线期间所有编辑照常生成操作，写入浏览器 localStorage 队列并即时在本地 fold 显示。
2. 重连握手时客户端发送自己的 VV；服务端只返回它缺失的操作
   （`ops` 中每客户端序号大于客户端 VV 的记录）。
3. 客户端按服务端权威 VV 清理队列中已落盘的操作，其余按 Lamport 顺序补传
   （服务端用 `(play_id, op_id)` 主键去重，重复补传是幂等的）。

### 确定性冲突解决（全序键）

所有操作按全序键排序：**`(lamport, clientId, clientSeq)`**，字典序较小者在前。
fold 是操作日志集合的纯函数——收到相同操作集合的任意客户端必然得到相同结果。

| 冲突场景 | 规则 |
| -------- | ---- |
| 并发移动 / 重命名同一字段 | 全序键最大者胜出（Lamport 大的赢；平局 clientId 字典序赢），但**所有候选值保留为冲突**，侧栏可一键改用任一候选 |
| 因果移动（后操作者见过前者） | 后者直接覆盖，不算冲突 |
| 删除 vs 并发移动/重命名 | 确定性结果为**已删除**，同时标记 `delete` 冲突，侧栏可「恢复」或「再次删除」 |
| 删除 vs 恢复 并发 | 按全序顺序的最后一条生命周期操作决定死活，并标记 `delete-restore` 冲突 |
| 同一客户端的陈旧写 | 后发操作的 VV 自动覆盖自己的旧操作，陈旧写被剔除 |
| 动作所属场次被删 | 动作在视图中隐藏（不删除数据），场次恢复后自动回归 |
| 元素排序 | 场景/音效/动作均按 `(开始时间, createKey)` 稳定排序 |
| 场次提示单 | 只读视图：列出半开区间 `[场次起点, 场次终点)` 内开始的可见动作与音效，按同一稳定序排列，附相对起点时间与时长；纯读取折叠视图，不产生操作 |

冲突分三类显式呈现：`edit`（并发字段编辑，含全部候选值）、`delete`（删除×编辑）、
`delete-restore`（删除×恢复）。

### JSON 导入 / 导出

- **导出**：`GET /api/plays/{id}/export`（或前端按钮，离线时导出本地视图）得到
  `rehearsal-timeline/v1` 文档，含 `snapshot`（当前视图）与完整 `operations`（日志），
  时间单位为毫秒。
- **导入到现有剧目**：`POST /api/plays/{id}/import`，按 `opId` 去重合并，导入操作的
  Lamport 时间戳整体平移到服务端当前时钟之后，作为新写入安全合并。
- **导入为新剧目**：`POST /api/import`。

---

## REST API 摘要

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/plays` | 剧目列表 |
| POST | `/api/plays` | 新建剧目 `{"title": "..."}` |
| PATCH | `/api/plays/{id}` | 重命名 |
| GET | `/api/plays/{id}/state` | 服务端 fold 视图 + VV |
| GET | `/api/plays/{id}/export` | 导出 JSON |
| POST | `/api/plays/{id}/import` | 合并导入 |
| POST | `/api/import` | 导入为新剧目 |
| WS | `/ws/{playId}` | 实时通道（首帧须为 `hello`） |

WebSocket 消息：`hello` / `snapshot` / `op` / `op-ack` / `op-rejected` /
`presence` / `ping` / `pong` / `profile`。服务端每 10 秒心跳，30 秒无心跳的
成员自动从在线列表剔除。

---

## 项目结构

```
app/
  engine.py     # 确定性合并引擎：fold / build_view / VV（纯函数）
  db.py         # aiosqlite：plays 表 + ops 追加日志（opId 幂等）
  ws.py         # WebSocket 管理器：校验、增量快照、在线成员、心跳
  main.py       # FastAPI：REST、导入导出、静态托管
static/
  index.html    # 时间线、侧栏、加入页
  style.css
  engine.js     # 与 engine.py 等价的 JS 合并引擎
  app.js        # 状态、WS 客户端、离线队列、拖拽与渲染
tests/
  test_engine.py       # 合并语义（10 个场景）
  test_integration.py  # REST + WebSocket 端到端（并发/重连/导入导出）
  engine.node.mjs      # JS 引擎等价性检查
docker-compose.yml / Dockerfile / requirements.txt
```

## 测试

```bash
pip install -r requirements.txt pytest httpx
python -m pytest tests/        # 16 项：合并语义（含只读场次提示单）+ 服务端端到端
node tests/engine.node.mjs     # JS 引擎等价性
```
