# -*- coding: utf-8 -*-
"""从服务器拉文件（SFTP）。凭据读 .data/config.json 的 server 段。

用法：python tools/ssh-get.py <远端> <本地> [<远端> <本地> ...]
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
        print('用法: ssh-get.py <远端> <本地> [<远端> <本地> ...]')
        return 2
    srv = json.load(open(CFG, encoding='utf-8'))['server']
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(srv['host'], port=srv.get('port', 22), username=srv['user'],
                password=srv['password'], timeout=20)
    sftp = cli.open_sftp()
    for i in range(0, len(pairs), 2):
        dst = pairs[i + 1] if os.path.isabs(pairs[i + 1]) else os.path.join(ROOT, pairs[i + 1])
        d = os.path.dirname(dst)
        if d and not os.path.isdir(d):
            os.makedirs(d)
        sftp.get(pairs[i], dst)
        print('GET %s -> %s (%d bytes)' % (pairs[i], dst, os.path.getsize(dst)), flush=True)
    sftp.close()
    cli.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
