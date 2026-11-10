# -*- coding: utf-8 -*-
import json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
import paramiko

cfg = json.load(open(r'G:\资料\Github-Plugin\Secretary\.data\config.json', encoding='utf-8'))
s = cfg['server']
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(s['host'], s['port'], s['user'], s['password'], timeout=15)

cmds = [
    ("voice-in-archive",
     "docker exec wechat sh -c \"grep -h '|voice|' /data/archive/2026-11-10/*.jsonl 2>/dev/null | tail -8\""),
    ("asr-backfilled",
     "docker exec wechat sh -c \"grep -h 'asr' /data/archive/2026-11-10/*.jsonl 2>/dev/null | tail -6\""),
    ("vl-log",
     "docker exec wechat sh -c \"grep -aE 'VL|asr|voice' /tmp/wx_agent.log | tail -20\""),
]
for tag, cmd in cmds:
    _, out, err = c.exec_command(cmd)
    print('=== %s ===' % tag)
    print(out.read().decode('utf-8', 'replace').strip() or '(empty)')
c.close()
