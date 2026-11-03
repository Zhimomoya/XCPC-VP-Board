# 启动方式与 Ubuntu / WSL

## 原生 Ubuntu

安装 Python 3.10 或以上。进入解压后的项目目录，运行 `python3 server.py`，然后访问 [http://127.0.0.1:8770/](http://127.0.0.1:8770/)。

需要让队友访问时，运行 `bash start-ubuntu.sh`，它等同于 `python3 server.py --lan`。主机继续用本机地址，队友使用终端打印的局域网地址。首次启动显示 `Contest data: 0 downloaded` 时，可以从准备页下载历史比赛或导入本地文件。

若启用了 UFW，在可信网络上按需放行使用的 TCP 端口。例如默认端口可运行 `sudo ufw allow 8770/tcp`。如果队友仍连不上，确认两台设备可以在同一网络中互访，校园网和公共 Wi-Fi 可能隔离设备。

## WSL 2

在 Windows PowerShell 运行 `wsl --list --verbose`，确认 Ubuntu 使用 WSL 2。在 Ubuntu 终端进入项目目录，再运行 `python3 server.py`。Windows 磁盘挂载在 `/mnt/` 下，例如 `D:\Projects\XCPC-Board` 对应 `/mnt/d/Projects/XCPC-Board`。

榜单服务在 WSL 中运行时，浏览器和扩展可以装在 Windows。打开 [http://127.0.0.1:8770/](http://127.0.0.1:8770/)，在扩展管理页加载项目里的 `qoj-bridge/` 文件夹。若项目位于 WSL 文件系统，先把扩展目录复制到 Windows 可访问的位置，并在更新时同步该目录。

需要局域网共享时，WSL 默认 NAT 下打印的内部地址可能只供本机访问。如果队友连不上，可直接在 Windows 运行 `python server.py --lan`，或在支持镜像网络的 Windows 11 / WSL 环境中配置镜像网络和防火墙。

## 后台运行

启动脚本默认开启局域网访问。前台启动时可用 `Ctrl+C` 停止，后台服务用对应的停止脚本。

**Ubuntu**

```bash
bash start-silent.sh
bash stop-silent.sh
```

自定义端口用 `bash start-silent.sh --port 8870` 和 `bash stop-silent.sh 8870`。默认日志位于 `data/logs/server-ubuntu-8770.log`。

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File .\start-silent.ps1
powershell -ExecutionPolicy Bypass -File .\stop-silent.ps1
```

两个脚本都可以加 `-Port 8870`。默认日志位于 `data/logs/server-windows-8770.log`，错误日志使用 `.error.log` 后缀。

## 比赛时钟

服务启动时尝试网络校时，比赛开始后通过单调时钟推进。手动开赛时间按北京时间解释。断网重启后如果页面显示使用本机时钟，手动开赛前请先校准主机时间。

切换系统或升级前先停止服务，然后备份 `data/`。Windows 和 WSL 共用同一份 `data/` 时，每次只启动一个服务。比赛数据迁移方式见 [导入手册](IMPORT.md)。
