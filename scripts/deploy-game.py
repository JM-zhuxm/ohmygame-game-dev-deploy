#!/usr/bin/env python3
"""把本地 web-game 项目的构建产物发布到 cargo20.com/games/<slug>/。

用法:
    python3 deploy-game.py <本地项目目录> <slug>

流程:
    1. 在本地跑 npm run build（产物在 dist/）
    2. 打包 → scp → 解压到 /var/www/games.local/<slug>/
    3. 校验外网可访问

要求: 目标项目已有 npm run build 产出 dist/index.html
"""
import os
import subprocess
import sys
import tarfile
import tempfile

HOST = "ubuntu@139.199.194.20"
KEY = "/home/mogege/lh0527.pem"
REMOTE_ROOT = "/var/www/games.local"
SSH = f"ssh -i {KEY} -o StrictHostKeyChecking=no {HOST}"
SCP = f"scp -i {KEY} -o StrictHostKeyChecking=no"


def run(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 1
    project, slug = sys.argv[1], sys.argv[2]
    dist = os.path.join(project, "dist")
    if not os.path.exists(os.path.join(dist, "index.html")):
        print(f"缺少 {dist}/index.html，先在 {project} 跑 npm run build")
        return 1

    with tempfile.TemporaryDirectory() as tmp:
        tar_path = os.path.join(tmp, f"{slug}.tar.gz")
        with tarfile.open(tar_path, "w:gz") as tf:
            tf.add(dist, arcname="dist")
        size = os.path.getsize(tar_path)
        print(f"打包 {size/1024/1024:.2f} MB")

        up = run(f"{SCP} {tar_path} {HOST}:/tmp/{slug}.tar.gz")
        if up.returncode != 0:
            print("scp 失败:", up.stderr[:300])
            return 1

        cmds = (
            f"sudo rm -rf {REMOTE_ROOT}/{slug} && "
            f"sudo mkdir -p {REMOTE_ROOT}/{slug} && "
            f"sudo tar xzf /tmp/{slug}.tar.gz -C {REMOTE_ROOT}/{slug} --strip-components=1 && "
            f"sudo chown -R www-data:www-data {REMOTE_ROOT}/{slug} && "
            f"rm -f /tmp/{slug}.tar.gz && "
            f"du -sh {REMOTE_ROOT}/{slug}"
        )
        dep = run(f"{SSH} {cmds!r}")
        if dep.returncode != 0:
            print("远端部署失败:", (dep.stderr or dep.stdout)[:400])
            return 1
        print("远端:", dep.stdout.strip())

    chk = run("curl -s -m 25 -o /dev/null -w '%{http_code}' "
               f"https://cargo20.com/games/{slug}/")
    code = chk.stdout.strip()
    print(f"外网 https://cargo20.com/games/{slug}/ → HTTP {code}")
    if code != "200":
        print("外网访问异常，请检查 nginx 配置")
        return 1
    print("✓ 发布成功")
    return 0


if __name__ == "__main__":
    sys.exit(main())
