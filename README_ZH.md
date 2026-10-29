<div align="center">

<img src="readme-assets/title.svg" alt="EFTForge" width="301">

**新一代逃离塔科夫武器与弹道模拟平台**

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100%2B-009688?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue?style=flat-square)](LICENSE)

[English](README.md) · [中文](README_ZH.md)

</div>

---

在线使用：**[eftforge.com](https://eftforge.com)**。游戏数据来源于 [tarkov.dev](https://tarkov.dev) 与 [SP-Tushonka](https://github.com/SP-Tushonka)。

## Kitbash!

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="readme-assets/kitbash-for-eftforge-wordmark.png">
  <img src="readme-assets/kitbash-for-eftforge-wordmark-dark-ink.png" alt="Kitbash! for EFTForge" width="306">
</picture>

*自定义塔科夫配置，毫秒级渲染。*

<sub>标志中的步枪是由 Kitbash! 绘制的真实配置。<a href="https://eftforge.com/?build=N4IgbiBcCMA0IHMogGwAYUFYAcB2ATJoQMyYDGmuAhtMQCz51kBmAJiPAA5QDaPqGHASKZSFarQZNmzDiEwBOVgCNiNVthTNcuBgoCmaTMrr6F%2BEAF1Y-dFjyES5SjXqNWaNHMWsU%2BAnSa2rooKNB0KMRBsta2gg4iYi6S7mjQcnZCVNjYCp6sZPisClSYxlgKVjYC9sJO4q5SHhbw5LgKxMzK5vr4%2BNAodHTMxNDKXYNVcbWOos4SbnQexBnxuMq%2BHhu4OBjQ61RkZFM1WTl5aAVFJWXKWMfwmXi4WvhkyviG%2BFQMh73KJye1HO%2BUKxVK5Uw7Ee8WwaDItCKS2gb2w0DY2FYVEBa2yuVB1whd0w%2Bm8yjIaBK0ExdFI0EMaFIfju2FJsXkZHanW6nz6AyGIzGExQGSIHVw8LoRlKzEw0FYzWIKmwONqL2Ybw%2BXx%2B3zIvWhqFokuIZBQEuwJLoJOY4Wl6XZQPVms%2BaG%2Bvz1n1WWAK2FcSNYKLIaIx%2BhWDth8MRrGRqPRGkMZIpJWIl1pcoZxDNXVwQdVODhCOI-sDwY0rFkrRzMjufitCh0kXwIwU0CoCkqDqNZFppvNluttswVBWrXLw9Y%2BGUl30%2BjGfWYmk%2BVFYbOsIGxkHkBiWSvwQR0dH2KGHfkwaGxAF8gA">在 EFTForge 中打开</a></sub>

</div>

Kitbash! 是 EFTForge 背后的渲染引擎，由 [Morph1ne](https://github.com/SouthHorizons76) 开发。它包含两部分：
- **3D 引擎**：驱动 3D 改装界面
- **2D 精灵图合成器**：绘制站内所有配置图像，从工作台实时预览到社区方案卡片

当前版本为 **Kitbash! Arcadia**，在最初的 2D 合成器 **Kitbash! Sirius** 基础上加入了 3D 引擎。

Kitbash! 是一个独立项目，其仓库目前为私有，在未来可能会开源！

## Atlas

<div align="center">

<img src="frontend/assets/images/atlas-logo.svg" alt="" width="56">
<img src="frontend/assets/images/atlas-wordmark.svg" alt="Atlas" width="190">

</div>

Atlas 是一个独立项目，记录「逃离塔科夫」游戏数据的每一处变动，地址为 [eftforge.com/atlas](https://eftforge.com/atlas)。它托管在 eftforge.com 上，仅是为了节省托管成本、方便开发。变动记录在检测到 12 小时后公开。

## 桌面版

Windows 桌面版在你自己的电脑上运行全部功能，适合网站在你所在地区访问较慢或暂时无法访问时使用。物品数据与图片仍需联网从 tarkov.dev 获取，3D 改装界面只能在**连接 EFTForge.com** 模式下使用。

从 [GitHub Releases](https://github.com/SouthHorizons76/EFTForge/releases) 下载；GitHub 较慢时可使用 [Gitee 镜像](https://gitee.com/morph1ne/eftforge-gitee-mirror/releases)。构建方法见 [desktop/README.md](desktop/README.md)。

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

# 社区方案图像生成（可选，只用于公开服务器）
GITEE_TOKEN=                 # 用于上传方案卡片图像的 Gitee 个人访问令牌
GITEE_DRY_RUN=0              # 设为 1 可模拟上传而不实际写入 Gitee
DISABLE_BG_MIGRATE=0         # 设为 1 可禁用后台图像迁移任务
```

---

### 4. 运行 `launch.bat`

```bat
launch.bat
```

这一条命令会完成以下所有操作：
- **首次运行**：重建数据库、从 tarkov.dev 同步全部物品数据，然后再启动，因为此时还没有数据可提供
- **后续运行**：直接基于已有的本地数据库立即启动 FastAPI 后端，同时在后台重新同步 tarkov.dev 数据
- 在 `http://127.0.0.1:8000` 启动 FastAPI 后端
- 在 `http://127.0.0.1:5500` 提供前端服务
- 自动打开浏览器标签页

后端控制台显示 **"Application startup complete"** 后即可使用网站。如果后台同步发现了新数据，会弹出提示引导你刷新页面；否则不会有任何变化，你可以继续使用已有数据。此时EFTForge已经成功运行了。

> **3D 改装界面：** 本地运行时，3D 视图需要在 `http://127.0.0.1:8765` 上运行 Kitbash! 查看器，否则使用 2D。

> **注意：** `sync_tarkov_dev.py` 由launch.bat自动调用。本地开发时请尽量不要直接运行该脚本，它仅用于生产服务器上的手动计划外数据重同步。

## 外部配置加载

外部工具可通过 `?build=` URL 参数打开 EFTForge 并预加载配置方案：

```
https://eftforge.com/?build=<配置码>
```

加载器支持三种配置码格式：基于字典的 `3.` 格式、包含完整 ID 的紧凑 `2.` 格式，以及旧版 LZ-String 格式。EFTForge 会为每套配置方案生成 `3.` 和 `2.` 中较短的一种。

- **紧凑格式**：参照 [`frontend/modules/build-codes.js`](frontend/modules/build-codes.js) 中的编码器即可生成任一种。`3.` 格式还需要 [`frontend/data/build-code-catalog-v1.js`](frontend/data/build-code-catalog-v1.js) 中的固定物品与槽位字典；格式和字典规则见 [`scripts/BUILD_CODES.md`](scripts/BUILD_CODES.md)。某个 ID 或槽位不在字典中时，请使用 `2.` 格式。两种紧凑格式都不需要在服务器上为每套配置保存记录。
- **旧版格式**：最简单的方式，使用 LZ-String 的 `compressToEncodedURIComponent(JSON.stringify(payload))` 生成。

三种格式表示相同的载荷：

```json
{ "v": 1, "g": "<gunId>", "p": [["slotId", "itemId"], ...], "a": "<ammoId>", "ua": "<ubglAmmoId>" }
```

`a` 和 `ua` 弹药字段均可省略。EFTForge 会在页面打开时自动载入配置方案并清除 URL 参数。物品 ID 须与 EFTForge 使用的 tarkov.dev 物品 ID 保持一致。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 报告，不要提交公开 issue。

## 致谢

真实人机（TrueErgo）源自 **SpaceMonkey37** 提出的 EvoErgo 概念。改枪优化器参考 **AhaiMk01** 的 [塔科夫改枪优化器](https://github.com/AhaiMk01/tarkov-weapon-optimizer) 思路重新实现。

## 开源协议

[AGPL-3.0-or-later](LICENSE)。如果你分发修改后的版本，或将其作为服务提供给他人使用，必须以相同许可证公开完整源代码，并保留对 EFTForge 的署名（见 [NOTICE](NOTICE)）。改用 AGPL 之前发布的版本仍可按 MIT 许可证使用。

## 免责声明

EFTForge、Kitbash! 与 Atlas 均为第三方自制项目，与 Battlestate Games 官方无关。
