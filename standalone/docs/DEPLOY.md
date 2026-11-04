# 服务器部署

本文以当前线上环境为蓝本：Debian 12、2 核 / 2GB、宝塔 nginx、Docker 中的 new-api。

## 1. 目录布局

```
/opt/node/                      Node 24 运行时（官方二进制）
/opt/RelayDeck/
├─ app/                         上游插件（lib + package.json + node_modules）
├─ standalone/                  本项目（src / public / node_modules 软链）
├─ data/                        HUB_HOME
├─ run.sh                       启动包装脚本（自动发现 Docker 网桥 IP）
└─ RelayDeck.service              systemd 单元（也放在 /etc/systemd/system/）
```

## 2. 安装 Node

```bash
cd /opt
curl -sSLO https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz
curl -sSLO https://nodejs.org/dist/v24.22.2/SHASUMS256.txt
grep 'node-v24.22.2-linux-x64.tar.xz' SHASUMS256.txt | sha256sum -c -
tar xJf node-v24.22.2-linux-x64.tar.xz
ln -sfn /opt/node-v24.22.2-linux-x64 /opt/node
```

`npm` 的 shebang 是 `#!/usr/bin/env node`，调用前记得：

```bash
export PATH=/opt/node/bin:$PATH
```

## 3. 安装应用

```bash
# 上传构建产物（本仓库的 app/ + standalone/）
tar xzf RelayDeck-bundle.tar.gz -C /opt/RelayDeck

# 安装生产依赖
cd /opt/RelayDeck/app
npm install --omit=dev --ignore-scripts --registry=https://registry.npmmirror.com
npm install --ignore-scripts \
  @deepseek-ai/cordis@4.0.5 \
  @deepseek-ai/dsh-credentials@0.2.1-rc.5 \
  @deepseek-ai/dsh-llm@0.2.1-rc.5 \
  @deepseek-ai/schemastery@3.18.5

# 让 standalone 复用 app 的依赖
ln -sfn ../app/node_modules /opt/RelayDeck/standalone/node_modules
```

> 为什么需要单独装 peer：上游 `package.json` 把它们放在 `peerDependencies`，而 npm 在 `--omit=dev` 下不会自动安装同时出现在 `devDependencies` 里的 peer。漏装会在启动时报 `ERR_MODULE_NOT_FOUND`。

## 4. 让 new-api 能访问网关

网关插件拒绝绑定 `0.0.0.0`。new-api 在 Docker 里，`127.0.0.1` 指向容器自身，因此要绑到 **Docker 网络在宿主侧的网关地址**。

`/opt/RelayDeck/run.sh` 会自动探测：

```bash
#!/bin/bash
set -u
NET="${HUB_GATEWAY_NETWORK:-newapi_default}"
GW=$(docker network inspect "$NET" -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)
[ -z "$GW" ] && GW=127.0.0.1
export HUB_GATEWAY_HOST="$GW"
exec /opt/node/bin/node /opt/RelayDeck/standalone/src/index.mjs start
```

放行容器网段：

```bash
ufw allow from 172.20.0.0/16 to any port 8326 proto tcp
```

验证（在 new-api 容器里）：

```bash
docker exec new-api wget -q -O /dev/null \
  --header='Authorization: Bearer <网关Key>' \
  http://172.20.0.1:8326/v1/models
```

## 5. systemd

`/etc/systemd/system/RelayDeck.service`：

```ini
[Unit]
Description=RelayDeck AI relay gateway
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/RelayDeck/standalone
Environment=PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=HUB_HOME=/opt/RelayDeck/data
Environment=HUB_GATEWAY_PORT=8326
Environment=HUB_ADMIN_HOST=127.0.0.1
Environment=HUB_ADMIN_PORT=8327
ExecStart=/opt/RelayDeck/run.sh
Restart=always
RestartSec=5
MemoryMax=800M
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now RelayDeck
systemctl status RelayDeck
journalctl -u RelayDeck -f
```

## 6. 管理端反向代理

管理端只绑 `127.0.0.1:8327`，由 nginx 在独立端口提供 HTTPS + Basic Auth。

```nginx
server {
    listen 8443 ssl;
    http2 on;
    server_name <你的域名或 sslip 域名>;

    ssl_certificate     /etc/letsencrypt/live/<域名>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<域名>/privkey.pem;

    auth_basic "RelayDeck admin";
    auth_basic_user_file /www/server/nginx/.htpasswd-hub;

    location / {
        proxy_pass http://127.0.0.1:8327;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
}
```

生成口令：

```bash
printf 'admin:%s\n' "$(openssl passwd -apr1 '你的密码')" > /www/server/nginx/.htpasswd-hub
chown www:www /www/server/nginx/.htpasswd-hub
chmod 640 /www/server/nginx/.htpasswd-hub
```

> nginx 以 `www` 用户运行，htpasswd 文件必须是 `www` 可读，否则会 500 并在错误日志里报 `Permission denied`。

证书签发（使用 sslip.io 时）：

```bash
certbot certonly --webroot -w /www/wwwroot/newapi-acme \
  -d api.example.com --non-interactive --agree-tos \
  --register-unsafely-without-email
```

## 7. 升级

```bash
# 1) 构建机：重新构建 vendor
cd vendor/dsh-providers-hub && npm install && npm run build && node scripts/copy-assets.mjs

# 2) 打包 app/ 与 standalone/ 上传
tar czf RelayDeck-bundle.tar.gz app standalone

# 3) 服务器
systemctl stop RelayDeck
tar xzf RelayDeck-bundle.tar.gz -C /opt/RelayDeck
cd /opt/RelayDeck/app && npm install --omit=dev --ignore-scripts
systemctl start RelayDeck
journalctl -u RelayDeck -n 50 --no-pager
```

升级前备份：

```bash
tar czf /root/RelayDeck-backup-$(date +%F).tar.gz /opt/RelayDeck/data
```

## 8. 资源占用（实测）

| 项 | 值 |
|---|---|
| 常驻内存 | 78–95 MB |
| 启动时间 | < 2 s |
| 数据目录 | < 1 MB（不含日志） |
| CPU | 空闲近 0，单请求主要耗在等上游 |

---

## 附：Docker 部署（可选）

如果不想在宿主装 Node，可以把 hub 做成容器，与 new-api 放入同一 compose 网络：

```dockerfile
FROM node:24-bookworm-slim
WORKDIR /app
COPY app/ ./app/
COPY standalone/ ./standalone/
RUN ln -s ../app/node_modules /app/standalone/node_modules
WORKDIR /app/standalone
ENV HUB_HOME=/data
CMD ["node", "src/index.mjs", "start"]
```

容器内同样不能绑 `0.0.0.0`；把 `HUB_GATEWAY_HOST` 设为**容器自身 IP**（启动脚本里 `hostname -i`），并确保 new-api 能解析到该地址。更省事的做法仍是宿主 + systemd。


---

## 附：自有域名

线上已切换到：

| 用途 | 域名 | 反代目标 |
|---|---|---|
| new-api | `api.<你的域名>` | `127.0.0.1:3000` |
| RelayDeck 管理端 | `relay.<你的域名>` | `127.0.0.1:8327`（Basic Auth） |

证书：`/etc/letsencrypt/live/hackathon-relaydeck/`，同一张证书覆盖两个子域，
`certbot.timer` 自动续期。nginx 配置：`/www/server/panel/vhost/nginx/relaydeck-domain.conf`。
