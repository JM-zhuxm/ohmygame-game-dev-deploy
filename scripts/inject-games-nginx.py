#!/usr/bin/env python3
"""在远程 cargo20.com 的 nginx 配置里注入 /games/ 静态挂载块。

块结构与既有的 /campus/、/ludi/ 保持一致：alias + index + SPA 回退。
幂等：已存在则跳过。写入前自动备份，nginx -t 失败自动回滚。
"""
import subprocess
import sys

HOST = "ubuntu@139.199.194.20"
KEY = "/home/mogege/lh0527.pem"
CONF = "/etc/nginx/sites-enabled/cargo20.com"

BLOCK = """
    # ========== /games/ 路径 - OhMyGame 小游戏托管 (2026-10-28) ==========
    # 由本机 OhMyGame Daemon 构建的 web-game 静态产物
    location ^~ /games/ {
        alias /var/www/games.local/;
        index index.html;
        try_files $uri $uri/ /games/index.html;
    }

    # 静态资源长缓存
    location ~* ^/games/.*\\.(js|css|woff2?|svg|png|jpg|jpeg|gif|webp|webm|mp4|mp3)$ {
        alias /var/www/games.local/;
        expires 7d;
        add_header Cache-Control "public, immutable";
        access_log off;
    }
"""

ANCHOR = "    location / {\n        root /var/www/cargo20.com/client/dist;"


def run(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True)


def ssh(cmd):
    return run(f"ssh -i {KEY} -o StrictHostKeyChecking=no {HOST} {cmd!r}")


def main():
    cur = ssh(f"sudo cat {CONF}").stdout
    if not cur:
        print("读取配置失败")
        return 1
    if "/games/" in cur:
        print("配置里已有 /games/ 块，跳过注入")
        return 0
    if ANCHOR not in cur:
        print("找不到锚点 location /，中止")
        return 1

    updated = cur.replace(ANCHOR, BLOCK.rstrip("\n") + "\n\n" + ANCHOR, 1)
    with open("/tmp/cargo20.games.conf", "w") as fh:
        fh.write(updated)
    run(f"scp -i {KEY} -o StrictHostKeyChecking=no /tmp/cargo20.games.conf {HOST}:/tmp/cargo20.games.conf")

    stamp = ssh("date +%Y%m%d_%H%M%S").stdout.strip()
    backup = f"{CONF}.bak-pre-games-{stamp}"
    ssh(f"sudo cp {CONF} {backup}")
    ssh(f"sudo cp /tmp/cargo20.games.conf {CONF}")
    print(f"已注入 /games/ 块 (备份 {backup})")

    chk = ssh("sudo nginx -t 2>&1")
    tail = (chk.stdout or chk.stderr).strip().splitlines()
    print("nginx -t:", tail[-1] if tail else "(无输出)")
    if "successful" not in (chk.stdout or ""):
        print("配置校验失败，回滚")
        ssh(f"sudo cp {backup} {CONF}")
        ssh("sudo nginx -t")
        return 1

    ssh("sudo systemctl reload nginx")
    print("nginx 已 reload")
    return 0


if __name__ == "__main__":
    sys.exit(main())
