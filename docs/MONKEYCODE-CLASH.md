# MonkeyCode 工作区 → Tailscale → RelayDeck → FlClash 全记录

> 本文记录从 MonkeyCode（`https://monkeycode-ai.net/`）的临时工作区出发，
> 安装 Tailscale、SSH 进去、部署 RelayDeck、再用 FlClash 把它的网络当作出口的
> 完整过程，包括踩过的坑与对应命令。
>
> ⚠️ 文中所有 IP、域名、令牌都用 `<...>` 占位。实际值请按文中命令自行获取，
> **不要把真实令牌提交到仓库**。

---

## 0. 最终拓扑

```
你的 Mac
 ├─ FlClash（系统代理 127.0.0.1:7890）
 │     └─ 节点 RelayDeck-WS = socks5 127.0.0.1:11080
 │           └─ SSH 动态转发（-D 11080）
 │                 └─ Tailscale 加密隧道
 │                       └─ MonkeyCode 工作区（userspace tailscaled）
 │                             └─ 出口到互联网
 │
 └─ Tailscale 客户端 ── 直连工作区 100.x.x.x
       └─ Tailscale SSH（无需 sshd）→ 管理 RelayDeck
```

工作区里同时跑：

- `tailscaled`（userspace 模式）
- `RelayDeck`（OpenAI 兼容网关 `127.0.0.1:8326` + 管理端 `127.0.0.1:8327`）
- `cloudflared`（可选，把网关临时暴露到公网 HTTPS）

---

## 1. 这台机器是什么，有什么限制

MonkeyCode 给的是一个 **Firecracker 微虚拟机**里的工作区：

| 项 | 实际值 |
|---|---|
| 主机名 | `60d339a7-...`（每次工作区不同） |
| 系统 | Debian 12，root，**没有 systemd** |
| 公网 IP | **没有**，只有内网 `192.168.x.x` |
| 入站端口 | **没有**，NAT 后面 |
| 内存 | 标称 8GB，实际经常只剩 200–300MB（virtio-balloon 回收） |
| Swap | 0 |
| 磁盘 | 20G，约 17G 可用，写入 ~478MB/s |
| 网络 | 上传 ~158Mbps，下载 ~100–127Mbps |
| 生命周期 | **临时**，工作区重置后所有进程和数据消失 |

### 关键限制

1. **不能当 VPS**：没有持久化、没有公网入口、平台随时回收。
2. **不能当 Clash 节点**：Clash 需要公网 IP + 端口 + 代理协议；这里都没有。
3. **tailscaled 只能跑 userspace 模式**：容器没有 `/dev/net/tun`，所以：
   - 不能绑定 `100.x` 地址（会报 `EADDRNOTAVAIL`）
   - 不能做 exit node
4. **内存极不稳定**：看 `free` 的 `available`，不要看 `total`。

---

## 2. 工作区诊断

```bash
whoami; hostname
ip -4 addr show | grep inet
curl -s https://ifconfig.me; echo
ss -tlnp | grep ':22' || echo "没有 sshd"
which systemctl || echo "没有 systemd"
free -m
df -h /
```

典型输出：

```
root
60d339a7-...
inet 192.168.30.7/20
没有 sshd
没有 systemd
```

结论：**没有公网 IP、没有 sshd、没有 systemd**，所以不能直接 `ssh root@公网IP`。

---

## 3. 在工作区安装 Tailscale

### 3.1 安装

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

装完版本类似 `1.104.x`。

### 3.2 启动 tailscaled（userspace 模式）

容器没有 TUN，必须用 `-tun=userspace-networking`；同时没有 systemd，所以要手动后台运行：

```bash
mkdir -p /var/lib/tailscale

nohup tailscaled \
  -tun=userspace-networking \
  -socket=/tmp/tailscaled.sock \
  -state=/var/lib/tailscale/tailscaled.state \
  >/tmp/tailscaled.log 2>&1 &

sleep 3
ps aux | grep '[t]ailscaled'
```

> ⚠️ 参数是 `-socket`，不是 `-sock`。写错会直接 `exit 2`：
>
> ```
> flag provided but not defined: -sock
> ```

### 3.3 登录

```bash
tailscale --socket=/tmp/tailscaled.sock up --ssh --hostname=relaydeck-ws
```

会输出授权链接：

```
To authenticate, visit:
  https://login.tailscale.com/a/xxxxxxxx
```

在**任意设备**的浏览器打开、登录 Tailscale 账号、授权。成功后终端显示 `Success.`。

### 3.4 确认地址

```bash
tailscale --socket=/tmp/tailscaled.sock ip -4
# 例如 100.x.x.x
tailscale --socket=/tmp/tailscaled.sock status
```

### 3.5 常见错误

| 现象 | 原因 | 解决 |
|---|---|---|
| `flag provided but not defined: -sock` | 参数名错 | 用 `-socket` |
| `failed to connect to local tailscaled` | daemon 没起来 | 看 `/tmp/tailscaled.log` |
| `cannot open /dev/net/tun` | 没有 TUN | 保持 `-tun=userspace-networking` |
| 授权链接过期 | 超时 | 重新执行 `up` 生成新链接 |
| `tailscale serve` 报错 | userspace 限制 | 用 SSH 隧道代替 |

---

## 4. 在 Mac 上安装 Tailscale

### 4.1 安装

```bash
brew install --cask tailscale
```

如果当前终端没有 TTY，`brew` 调 `sudo` 会失败：

```
sudo: a terminal is required to read the password
```

解决办法（GUI 输入管理员密码）：

```bash
# 先只下载，不用 sudo
brew fetch --cask tailscale

# 找到 pkg
find ~/Library/Caches/Homebrew -name 'Tailscale-*.pkg' | head -1

# 用 GUI 提权安装
osascript -e 'do shell script "/usr/sbin/installer -pkg <pkg路径> -target /" with administrator privileges'
```

也可以直接从 App Store 安装。

### 4.2 首次启动

1. 打开 Tailscale → **Get started**
2. **System extension** → Grant permissions（需要在系统设置里允许，输入管理员密码）
3. **VPN Configuration** 自动显示 Granted
4. 登录同一个 Tailscale 账号
5. 顶部状态变成 **Connected**，设备列表里能看到 `relaydeck-ws`

验证：

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale status
```

---

## 5. 用 SSH 连接工作区

Tailscale 的 `--ssh` 会在工作区里提供 SSH 服务，**不需要装 openssh-server**，也不需要公网 IP。

在 Mac 上：

```bash
ssh root@<WORKSPACE_TAILSCALE_IP>
# 或 MagicDNS 名字
ssh root@relaydeck-ws
ssh root@relaydeck-ws.<TAILNET_DNS>
```

验证：

```bash
ssh root@<WORKSPACE_TAILSCALE_IP> "hostname; whoami"
```

能返回工作区主机名和 `root` 就成功。

> 没有密码：认证由 Tailscale 完成（你 Mac 上的 Tailscale 账号）。
> 如果报 `Permission denied`，去 Tailscale 后台 **Access controls** 检查 SSH 策略。

### 为什么不能直接 `ssh root@公网IP`

- 工作区没有公网 IP
- 平台没有映射 22 端口
- 容器里没有 sshd（Tailscale SSH 是 tailscaled 自带的）

---

## 6. 在工作区部署 RelayDeck

### 6.1 先看内存

```bash
free -m
```

注意看 **available**，不是 total。常见情况：

```
total 7965   used 7700   available 250
```

`virtio_balloon` 会把大部分内存收走：

```
dmesg | grep -i balloon
virtio_balloon virtio0: Out of puff! Can't get 1 pages
```

**结论：不要在工作区里 `npm install` / `tsc`，会 OOM。** 改为在 Mac 上构建，再上传产物。

### 6.2 在 Mac 上构建

```bash
cd /path/to/relaydeck/vendor/dsh-providers-hub
npm install --ignore-scripts
npm run build
node scripts/copy-assets.mjs
```

产物是 `lib/`。

### 6.3 上传到工作区

只上传运行所需内容，不含源码和 dev 依赖：

```bash
cd /path/to/relaydeck

# 插件本体（lib + 运行依赖）
tar czf - -C vendor/dsh-providers-hub \
  lib node_modules package.json locale cordis.patch.yml LICENSE \
  | ssh root@<WORKSPACE_TAILSCALE_IP> "tar xzf - -C /opt/relaydeck/app"

# 独立版代码
tar czf - -C standalone src public scripts package.json \
  | ssh root@<WORKSPACE_TAILSCALE_IP> "tar xzf - -C /opt/relaydeck/standalone"
```

> macOS 的 tar 会打印大量 `LIBARCHIVE.xattr.com.apple.provenance` 警告，可忽略。

### 6.4 目录与依赖软链

```bash
ssh root@<WORKSPACE_TAILSCALE_IP>
mkdir -p /opt/relaydeck/{app,standalone,data}
ln -sfn ../app/node_modules /opt/relaydeck/standalone/node_modules
```

### 6.5 启动脚本

`/opt/relaydeck/run.sh`：

```sh
#!/bin/sh
export HUB_HOME=/opt/relaydeck/data
export HUB_GATEWAY_HOST=127.0.0.1
export HUB_GATEWAY_PORT=8326
export HUB_ADMIN_HOST=127.0.0.1
export HUB_ADMIN_PORT=8327
export NODE_OPTIONS=--max-old-space-size=160
exec /usr/local/bin/node /opt/relaydeck/standalone/src/index.mjs start
```

```bash
chmod +x /opt/relaydeck/run.sh
nohup /opt/relaydeck/run.sh >/opt/relaydeck/relaydeck.log 2>&1 &
```

### 6.6 为什么绑定 127.0.0.1

一开始绑定 Tailscale 的 `100.x` 地址会失败：

```
[openai-gateway] 网关期望运行但未能监听：
listen EADDRNOTAVAIL: address not available 100.x.x.x:8326
```

因为 userspace 模式下 `100.x` 不在内核里。所以服务绑 `127.0.0.1`，外部访问靠 SSH 隧道或 cloudflared。

### 6.7 启动成功

```bash
tail -20 /opt/relaydeck/relaydeck.log
```

```
[relaydeck] 管理端已监听 http://127.0.0.1:8327/
网关      http://127.0.0.1:8326/v1
管理端    http://127.0.0.1:8327/
管理令牌  <ADMIN_TOKEN>
数据目录  /opt/relaydeck/data
```

管理令牌与网关 Key 在：

```bash
cat /opt/relaydeck/data/config.json
# adminToken / gatewayKey
```

### 6.8 健康检查

```bash
curl -H "x-admin-token: <ADMIN_TOKEN>" http://127.0.0.1:8327/api/health
# {"ok":true,"gateway":true,...}
```

### 6.9 工作区重启后恢复

```bash
# 1) Tailscale
nohup tailscaled -tun=userspace-networking \
  -socket=/tmp/tailscaled.sock \
  -state=/var/lib/tailscale/tailscaled.state \
  >/tmp/tailscaled.log 2>&1 &
sleep 3
tailscale --socket=/tmp/tailscaled.sock up --ssh

# 2) RelayDeck
cd /opt/relaydeck && nohup ./run.sh >/opt/relaydeck/relaydeck.log 2>&1 &
```

---

## 7. 访问管理端（SSH 隧道）

工作区里的管理端只监听 `127.0.0.1:8327`。在 Mac 上开本地转发：

```bash
ssh -f -N \
  -L 18327:127.0.0.1:8327 \
  -L 18326:127.0.0.1:8326 \
  root@<WORKSPACE_TAILSCALE_IP>
```

然后浏览器访问：

```
http://127.0.0.1:18327/
```

> `127.0.0.1:18327` 只是**你 Mac 上的隧道入口**，服务实际跑在云端工作区。

验证：

```bash
curl -H "x-admin-token: <ADMIN_TOKEN>" http://127.0.0.1:18327/api/health
```

---

## 8. 临时公网 HTTP 入口（cloudflared）

如果想让外部用户访问网关（不是管理端），用 Cloudflare Quick Tunnel：

### 8.1 安装

```bash
curl -fsSL -o /usr/local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /usr/local/bin/cloudflared
cloudflared --version
```

### 8.2 启动

```bash
pkill -f '^/usr/local/bin/cloudflared' 2>/dev/null || true

nohup /usr/local/bin/cloudflared tunnel --url http://127.0.0.1:8326 \
  --no-autoupdate >/tmp/cloudflared.log 2>&1 &

sleep 10
grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/cloudflared.log | head -1
```

得到类似：

```
https://<random>.trycloudflare.com
```

### 8.3 使用

```
Base URL: https://<random>.trycloudflare.com/v1
API Key:  <GATEWAY_KEY>
```

验证：

```bash
curl https://<random>.trycloudflare.com/v1/models \
  -H "Authorization: Bearer <GATEWAY_KEY>"
```

### 8.4 限制

- 随机域名，**cloudflared 进程一停就失效**，重启会换新域名
- 只支持 HTTP/HTTPS，**不能当 Clash 节点**（Clash 要 TCP/UDP 代理协议）
- 工作区重置后进程消失
- 没有 SLA，不适合长期对外

> 为什么 Clash 用不了 Cloudflare Tunnel：
> Tunnel 是 L7 HTTP 反代；Clash 节点需要 L4 的原始 TCP/UDP 代理协议（SS/VMess 等）。

---

## 9. 用 FlClash 走这台服务器的流量

Cloudflare 不行，但 **SSH 动态转发（SOCKS5）** 可以。原理：

```
FlClash → socks5 127.0.0.1:11080 → SSH 隧道 → 工作区 → 互联网
```

### 9.1 建立 SOCKS 隧道

在 Mac 上：

```bash
ssh -f -N -D 11080 root@<WORKSPACE_TAILSCALE_IP>
```

验证：

```bash
curl --socks5-hostname 127.0.0.1:11080 https://ifconfig.me
# 应返回工作区的出口 IP

curl https://ifconfig.me
# 本机直连 IP，应该不同
```

### 9.2 在 FlClash 配置里加节点

找到当前使用的 profile 文件：

```bash
ls "$HOME/Library/Application Support/com.follow.clash/profiles/"
```

备份：

```bash
cp "$PROFILE" "$PROFILE.bak-$(date +%s)"
```

在 `proxies:` 下加：

```yaml
- { name: RelayDeck-WS, type: socks5, server: 127.0.0.1, port: 11080, udp: false }
```

在 `proxy-groups:` 里把节点加进你常用的组，例如：

```yaml
- { name: 小蜜蜂, type: select, proxies: [RelayDeck-WS, 自动选择, ...] }
```

### 9.3 让 FlClash 重新加载

重启 FlClash：

```bash
pkill -f '^/Applications/FlClash.app' 2>/dev/null
sleep 3
open -a FlClash
```

> 用 AppleScript `quit app "FlClash"` 可能弹确认框并返回
> `用户已取消 (-128)`，所以直接用 `pkill`。

确认运行时配置已加载：

```bash
grep -n "RelayDeck-WS" "$HOME/Library/Application Support/com.follow.clash/config.yaml"
```

### 9.4 选中节点

在 FlClash 界面 → 代理 → 选择 `RelayDeck-WS`。

也可以直接改数据库（FlClash 关闭时）：

```bash
python3 - <<'PY'
import sqlite3, json, os
p = os.path.expanduser('~/Library/Application Support/com.follow.clash/database.sqlite')
con = sqlite3.connect(p)
pid = 373114551958245376  # 替换成你的 profile id
m = json.loads(con.execute('select selected_map from profiles where id=?', (pid,)).fetchone()[0] or '{}')
m['小蜜蜂'] = 'RelayDeck-WS'
m['GLOBAL'] = 'RelayDeck-WS'
con.execute('update profiles set selected_map=? where id=?', (json.dumps(m, ensure_ascii=False), pid))
con.commit()
PY
```

### 9.5 开启系统代理

FlClash 里打开「系统代理」，或检查：

```bash
networksetup -getwebproxy "Wi-Fi"
networksetup -getsocksfirewallproxy "Wi-Fi"
```

应指向 `127.0.0.1:7890`。

### 9.6 验证

```bash
curl -x http://127.0.0.1:7890 https://ifconfig.me
# 返回工作区出口 IP
```

浏览器打开 `https://ifconfig.me`，显示的是工作区 IP 就成功。

### 9.7 切回机场

FlClash → 代理 → 把组选回原来的节点（如「自动选择」），或关闭系统代理。

### 9.8 限制

| 项 | 说明 |
|---|---|
| 协议 | 只有 TCP，**没有 UDP** |
| 依赖 | Mac 的 Tailscale 必须运行，SSH 隧道必须活着 |
| 断线 | 隧道断 → 节点不可用 → 浏览器断网 |
| 订阅更新 | **会覆盖**手工加的节点，需要重新加 |
| 生命周期 | 工作区重启后隧道与节点都失效 |
| 速度 | 受工作区带宽限制（上传 ~158Mbps） |
| 合规 | 把开发沙箱当代理出口通常违反平台条款 |

### 9.9 隧道自动重连（可选）

```bash
brew install autossh
autossh -M 0 -f -N -D 11080 \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  root@<WORKSPACE_TAILSCALE_IP>
```

---

## 10. 实测数据

| 项目 | 结果 |
|---|---:|
| 下载（Cloudflare 50MB） | 12.3–15.9 MB/s（~99–127 Mbps） |
| 下载（Hetzner 100MB） | 7.4 MB/s（59 Mbps） |
| 上传（Cloudflare 50MB） | 19.8 MB/s（~158 Mbps） |
| 磁盘写入 | 478 MB/s |
| 到 api.openai.com TCP 握手 | 2.9 ms |
| RelayDeck RSS | ~100–126 MB |
| cloudflared RSS | ~38 MB |
| tailscaled RSS | ~38 MB + SSH 子进程 |

---

## 11. 故障与解决汇总

| 问题 | 现象 | 解决 |
|---|---|---|
| tailscaled 起不来 | `flag provided but not defined: -sock` | 参数改为 `-socket` |
| 连不上 tailscaled | `failed to connect to local tailscaled` | 看 `/tmp/tailscaled.log`，重新启动 |
| 网关绑定失败 | `EADDRNOTAVAIL ... 100.x` | userspace 下无 TUN，改绑 `127.0.0.1` |
| Mac 安装 Tailscale 失败 | `sudo: a terminal is required` | `brew fetch` + `osascript` 提权安装 |
| 系统扩展未授权 | 一直停在 Required permissions | 系统设置里允许，输入密码 |
| RelayDeck 构建 OOM | 进程被 kill | 在 Mac 构建，上传 `lib/` 与 `node_modules` |
| 内存显示 8G 但只剩 200MB | `virtio_balloon: Out of puff!` | 宿主回收，guest 无法控制 |
| Clash 节点连不上 | 超时 | 检查 `ssh -D` 是否存活、Tailscale 是否在线 |
| 订阅更新后节点没了 | 节点消失 | 重新编辑 profile，或改用自定义 profile |
| Cloudflare URL 502 | 上游返回错误 | 看工作区 `/opt/relaydeck/relaydeck.log`，通常是上游额度/账号问题 |

---

## 12. 安全与合规

1. **不要把管理端暴露公网**：只经 SSH 隧道访问。
2. **种子/令牌不要提交**：`data/config.json` 只在服务器上。
3. **工作区是临时的**：重要账号请用 RelayDeck 的备份功能导出。
4. **平台条款**：用开发沙箱做代理出口/VPN 通常被禁止，可能封号。
5. **法律风险**：在国内自建/运营代理服务（机场）涉及电信业务许可，对外提供有法律风险。
6. **正式服务**：请使用有公网 IP 的独立 VPS，不要依赖 MonkeyCode 工作区。

---

## 13. 一页命令速查

```bash
# ---------- 工作区 ----------
# 启动 Tailscale
nohup tailscaled -tun=userspace-networking -socket=/tmp/tailscaled.sock \
  -state=/var/lib/tailscale/tailscaled.state >/tmp/tailscaled.log 2>&1 &
sleep 3
tailscale --socket=/tmp/tailscaled.sock up --ssh --hostname=relaydeck-ws
tailscale --socket=/tmp/tailscaled.sock ip -4

# 启动 RelayDeck
cd /opt/relaydeck && nohup ./run.sh >/opt/relaydeck/relaydeck.log 2>&1 &
tail -20 /opt/relaydeck/relaydeck.log

# 公网 HTTP（可选）
nohup /usr/local/bin/cloudflared tunnel --url http://127.0.0.1:8326 \
  --no-autoupdate >/tmp/cloudflared.log 2>&1 &

# ---------- Mac ----------
# SSH
ssh root@<WORKSPACE_TAILSCALE_IP>

# 管理端隧道
ssh -f -N -L 18327:127.0.0.1:8327 -L 18326:127.0.0.1:8326 \
  root@<WORKSPACE_TAILSCALE_IP>

# Clash SOCKS 隧道
ssh -f -N -D 11080 root@<WORKSPACE_TAILSCALE_IP>
curl --socks5-hostname 127.0.0.1:11080 https://ifconfig.me

# FlClash 节点
# proxies:
#   - { name: RelayDeck-WS, type: socks5, server: 127.0.0.1, port: 11080, udp: false }
```
