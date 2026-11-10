# -*- coding: utf-8 -*-
"""取一张能扫的 QQ 登录二维码，拉回本地 .data/qq_qr_big.png。

真正干活的逻辑在 `server/qq-relogin.py`（要跑在服务器上：它要 docker cp 和
调 NapCat 的 WebUI）。这里只负责推上去、跑起来、把放大后的图 sftp 回来。

用法：python tools/qq-qr.py [--no-restart]
凭据读 .data/config.json 的 server 段，不落盘任何口令。
"""
import json
import os
import sys

import paramiko

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, '.data', 'config.json')
SRC = os.path.join(ROOT, 'server', 'qq-relogin.py')
REMOTE = '/opt/linux-im/_qq_relogin.py'
BIG = '/opt/linux-im/_qq_qr_big.png'
LOCAL = os.path.join(ROOT, '.data', 'qq_qr_big.png')


def main():
    srv = json.load(open(CFG, encoding='utf-8'))['server']
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(srv['host'], port=srv.get('port', 22), username=srv['user'],
                password=srv['password'], timeout=20)
    sftp = cli.open_sftp()
    sftp.put(SRC, REMOTE)
    sftp.close()

    arg = '' if '--no-restart' not in sys.argv else ' --no-restart'
    _i, out, err = cli.exec_command('python3 %s%s' % (REMOTE, arg), timeout=300)
    for line in iter(out.readline, ''):
        sys.stdout.write(line)
        sys.stdout.flush()
    e = err.read().decode('utf-8', 'replace').strip()
    if e:
        print('[stderr] %s' % e[-400:])

    sftp = cli.open_sftp()
    # 先删本地旧图：服务器那边万一没生成成功，sftp.get 会失败而不是把上一次
    # 的旧二维码当成新的发出去（踩过：拿 11-09 的过期码让用户扫）。
    if os.path.exists(LOCAL):
        os.remove(LOCAL)
    try:
        sftp.get(BIG, LOCAL)
        print('local: %s (%d bytes)' % (LOCAL, os.path.getsize(LOCAL)))
    except Exception as ex:
        print('下载失败: %s' % ex)
    sftp.close()
    cli.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
