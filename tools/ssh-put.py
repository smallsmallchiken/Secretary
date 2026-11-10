# -*- coding: utf-8 -*-
"""把本地文件推到服务器（SFTP）。凭据读 .data/config.json 的 server 段。

用法：python tools/ssh-put.py server/daily_report.py /opt/linux-im/daily_report.py [more pairs...]
"""
import json
import os
import sys

import paramiko

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, '.data', 'config.json')


def main():
    pairs = sys.argv[1:]
    if not pairs or len(pairs) % 2:
        print('用法: ssh-put.py <本地> <远端> [<本地> <远端> ...]')
        return 2
    srv = json.load(open(CFG, encoding='utf-8'))['server']
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(srv['host'], port=srv.get('port', 22), username=srv['user'],
                password=srv['password'], timeout=20)
    sftp = cli.open_sftp()
    for i in range(0, len(pairs), 2):
        src = pairs[i] if os.path.isabs(pairs[i]) else os.path.join(ROOT, pairs[i])
        try:
            sftp.put(src, pairs[i + 1])
        except Exception as e:
            print('FAIL %s -> %s : %s' % (src, pairs[i + 1], e), flush=True)
            continue
        print('PUT %s -> %s (%d bytes)' % (src, pairs[i + 1], os.path.getsize(src)), flush=True)
    sftp.close()
    cli.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
