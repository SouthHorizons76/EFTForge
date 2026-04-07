<div align="center">

# EFTForge

**实时逃离塔科夫武器配置模拟器，社区配置分享平台**

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100%2B-009688?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![数据来源: tarkov.dev](https://img.shields.io/badge/%E6%95%B0%E6%8D%AE-tarkov.dev-orange?style=flat-square)](https://tarkov.dev)

[English](README.md) · [中文](README_ZH.md)

</div>

---

## 项目简介

EFTForge 是一个逃离塔科夫武器配置模拟器。它提供递归配件树模拟、基于 EvoErgo 引擎的实时属性计算、冲突检测，以及社区配置方案发布平台。所有物品数据均通过 [tarkov.dev](https://tarkov.dev) GraphQL API 实时获取。

---

## 功能特性

### 装配模拟
- 递归配件树渲染，完整解析槽位与允许物品
- 出厂预设配件自动安装模拟
- 实时属性计算：人机功效、后坐力、重量、Evo人机Delta、过摆、手臂耐力
- 完整弹匣装弹重量建模
- 真实配件冲突检测（`conflictingItems` + `conflictingSlotIds`）
- 非阻断式冲突提示通知
- 通过 LZ-String 压缩的可分享配置代码
- 页面刷新后自动恢复上次装配进度

### EvoErgo 引擎
- 手臂耐力消耗计算
- Evo人机工效Delta（EED）计算
- 基于EED的过摆建模

### 社区平台
- 发布、浏览和加载社区装配方案
- 配件与配置方案点赞/踩评分系统
- 排行榜与推荐配置方案
- 管理员审核：推荐、下架、封禁
- 装配方案加载次数统计

### 本地化
- 中英文双语支持，自动回退
- 中文物品名称翻译与源数据并行存储

---

## 技术栈

| 层级 | 技术 |
|---|---|
| 后端 | Python、FastAPI、SQLAlchemy、SQLite、Pydantic、Uvicorn |
| 前端 | 原生 JavaScript（ES2022），模块化架构 |
| 数据来源 | tarkov.dev GraphQL API |
| 压缩 | LZ-String |
| Markdown | marked.js |

---

## 快速开始

### 环境要求

- Python 3.10+
- 现代浏览器（Chrome、Firefox、Edge 等）

---

### 1. 克隆Repo

```bash
git clone https://github.com/SouthHorizons76/EFTForge.git
cd EFTForge
```

---

### 2. 配置 `launch.bat`

在运行任何命令之前，用文本编辑器打开 `launch.bat`。

**浏览器路径** - 启动器会自动打开浏览器标签页。默认路径指向 Windows 上的 Chrome。如果你使用其他浏览器，请修改这行：

```bat
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --new-window ...
```

其他浏览器示例：
```bat
# Firefox
start "" "C:\Program Files\Mozilla Firefox\firefox.exe" -new-window ...

# Microsoft Edge
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --new-window ...
```

**安装 Python 依赖**，在 `backend/` 目录下执行：

```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
cd ..
```

---

### 3. 配置 `.env`

```bash
cd backend
copy .env.example .env
```

编辑 `backend/.env`。以下两个变量为**必填项** - 缺少任意一个服务将拒绝启动：

```env
IP_HASH_SECRET=任意随机字符串
ADMIN_API_KEY=你的管理员密钥
```

本地开发时填写任意非空值即可。生产环境请使用强随机值（`openssl rand -hex 32`）。

完整 `.env` 参考（除上述两项外均为可选）：

```env
DATABASE_URL=sqlite:///./tarkov.db
RATINGS_DB_URL=sqlite:///./ratings.db
BUILDS_DB_URL=sqlite:///./builds.db
CORS_ORIGINS=http://127.0.0.1:5500
ENABLE_API_DOCS=0            # 设为 1 可启用 /docs 和 /redoc
TRUSTED_PROXY_IPS=127.0.0.1,::1
```

---

### 4. 运行 `launch.bat`

```bat
launch.bat
```

这一条命令会完成以下所有操作：
- 清空并从头重建本地数据库
- 自动从 tarkov.dev 同步所有物品数据
- 在 `http://127.0.0.1:8000` 启动 FastAPI 后端
- 在 `http://127.0.0.1:5500` 提供前端服务
- 自动打开浏览器标签页

后端控制台显示 **"Application startup complete"** 后，网站将自动加载武器列表。此时EFTForge已经成功运行了。

> **注意：** `sync_tarkov_dev.py` 由launch.bat自动调用。本地开发时请尽量不要直接运行该脚本，它仅用于生产服务器上的手动计划外数据重同步。

---

## API 概览

后端默认运行于 `http://127.0.0.1:8000`。在 `.env` 中设置 `ENABLE_API_DOCS=1` 后可在 `/docs` 查看交互式文档。

| 分组 | 端点 |
|---|---|
| 物品 | `GET /guns`、`GET /ammo/{caliber}`、`GET /items/{id}/slots`、`GET /slots/{id}/allowed-items` |
| 装配 | `POST /build/validate`、`POST /build/calculate`、`POST /build/batch-process` |
| 评分 | `GET /ratings/attachments/bulk`、`POST /ratings/attachments/{id}/vote` |
| 社区装配 | `POST /builds/publish`、`GET /builds/public`、`POST /builds/{id}/load`、`DELETE /builds/{id}` |
| 通知 | `GET /builds/notifications`、`GET /announcements` |
| 管理员 | 装配管理、作者管理、封禁系统、公告 |

---

## 外部配置加载

外部工具可通过 `?build=` URL 参数直接跳转到 EFTForge 并预加载装配方案：

```
https://eftforge.com/?build=<lzstring编码的装配码>
```

装配码为经 LZ-String 压缩、URL 安全编码的 JSON 载荷：

```json
{ "v": 1, "g": "<gunId>", "p": [["slotId", "itemId"], ...], "a": "<ammoId>" }
```

EFTForge 将在页面加载时自动导入装配方案并清除 URL 参数。物品 ID 须与 EFTForge 内部的 tarkov.dev 物品 ID 保持一致。

---

## EvoErgo 致谢

EvoErgo 概念由 **SpaceMonkey37** 原创提出。EFTForge 在其基础上实现并扩展了这一系统。没有 SpaceMonkey37 的基础理论，本项目将无从实现。

---

## 开源协议

MIT - 详见 [LICENSE](LICENSE)。

---

## 免责声明

EFTForge 是一个第三方自制项目，与 Battlestate Games 官方无任何关联。所有游戏数据均来源于 [tarkov.dev](https://tarkov.dev)。
