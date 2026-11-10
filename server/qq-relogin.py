# -*- coding: utf-8 -*-
"""在服务器上跑：重启 NapCat 内核 → 等它出一张可扫的登录二维码 → 放大存盘。

为什么要重启：QQ 掉线（会话失效）后 NapCat 不会自己退回去扫新码，内核一直卡在
「等快速登录结果」，`qrcodeurl` 为空、`qrcode.png` 还是上次那张（早过期了）。

判「码是活的」用 WebUI 的两条信号，**不能只看 png 的 mtime**：
  1. `isLogin` 变成 true —— 说明用户已经扫了；
  2. `qrcodeurl` 相对重启前变了 —— 说明内核重新生成了码。
重启后老码可能还没过期，NapCat 会继续用同一张 png（mtime 不变），只看 mtime
会误判成「一直没有新码」（实测卡满 3 分钟超时）。

产出：
  /opt/linux-im/_qq_qr_raw.png   原始 147×147
  /opt/linux-im/_qq_qr_big.png   5 倍 NEAREST 放大（手机屏上也扫得动）
"""
import hashlib
import json
import subprocess
import sys
import time
import urllib.request

RESTART = '--no-restart' not in sys.argv
WAIT = 200
B = 'http://127.0.0.1:6099'
CFG = '/opt/napcat/config/webui.json'
QR_SRC = '/app/napcat/cache/qrcode.png'
RAW = '/opt/linux-im/_qq_qr_raw.png'
BIG = '/opt/linux-im/_qq_qr_big.png'


def sh(cmd, timeout=120):
    try:
        return subprocess.check_output(cmd, shell=True, stderr=subprocess.STDOUT,
                                       timeout=timeout).decode('utf-8', 'replace').strip()
    except Exception as e:
        return 'ERR: %s' % e


def api(path, data=None, hdr=None):
    q = urllib.request.Request(
        B + path, data=json.dumps(data or {}).encode(),
        headers=dict({'Content-Type': 'application/json'}, **(hdr or {})),
        method='POST')
    return json.loads(urllib.request.urlopen(q, timeout=12).read().decode())


def auth():
    t = json.load(open(CFG))['token']
    h = hashlib.sha256((t + '.napcat').encode()).hexdigest()
    c = api('/api/auth/login', {'hash': h, 'totpCode': ''})['data']['Credential']
    return {'Authorization': 'Bearer ' + c}


def status(H):
    try:
        return api('/api/QQLogin/CheckLoginStatus', {}, H).get('data', {})
    except Exception as e:
        return {'ERR': str(e)}


def export():
    """把容器里的 png 拷出来放大，返回 (尺寸, 深色像素数, 颜色数)。

    内层那段 python 里也有 `%`（`'dark=%d'`），**不能再拿 % 拼外层命令**——
    外层格式化会把内层的 `%d` 一起吃掉（踩过：TypeError: %d format）。
    统一用 str.format。
    """
    sh('docker cp {} {}'.format(QR_SRC, RAW))
    py = ("from PIL import Image;"
          "im=Image.open('/tmp/qr_in.png').convert('RGB');"
          "h=im.convert('L').histogram();"
          "print(im.size, 'dark=' + str(sum(h[:96])), 'colors=' + str(len(set(im.getdata()))));"
          "im.resize((im.width*5,im.height*5),Image.NEAREST).save('/data/_qq_qr_big.png')")
    cmd = ("docker cp {raw} wechat:/tmp/qr_in.png"
           " && docker exec wechat python3 -c \"{py}\""
           " && docker cp wechat:/data/_qq_qr_big.png {big}").format(raw=RAW, py=py, big=BIG)
    return sh(cmd)


def main():
    H = None
    old_k = ''
    try:
        H = auth()
        old_k = status(H).get('qrcodeurl') or ''
        print('before: k=%s' % old_k[-40:], flush=True)
    except Exception as e:
        print('pre-status err: %s' % e, flush=True)

    t0 = time.time()
    if RESTART:
        print('restart: %s' % sh('docker restart napcat'), flush=True)
    sh('rm -f %s %s' % (RAW, BIG))     # 先清旧图，避免拿上一天的码当新的发出去

    for i in range(30):                      # 等 WebUI 回来
        time.sleep(2)
        try:
            H = auth()
            break
        except Exception:
            H = None
    if H is None:
        print('!!! WebUI 一直没起来', flush=True)
        return 2

    k = ''
    deadline = time.time() + WAIT
    while time.time() < deadline:
        d = status(H)
        k = d.get('qrcodeurl') or ''
        phase = d.get('loginPhase')
        mt = sh("docker exec napcat stat -c %%Y %s 2>/dev/null || echo 0" % QR_SRC)
        png_ts = int(mt) if mt.isdigit() else 0
        png_new = png_ts > int(t0) - 3
        age = int(time.time()) - png_ts if png_ts else -1
        print('t+%3ds phase=%-16s login=%-5s k=%-5s png_age=%ss' % (
            int(time.time() - t0), phase, d.get('isLogin'), bool(k), age), flush=True)
        if d.get('isLogin'):
            print('>>> 已登录（码被扫过或本来就是登录态）', flush=True)
            return 0
        # 真正可靠的信号是 png 的 mtime：重启后内核重新生码时它一定会变。
        # qrcodeurl 在 `waiting_qrcode` 阶段经常是空的，只看它会白等（实测 200s）。
        if png_new or (k and k != old_k):
            print('export: %s' % export(), flush=True)
            print('QR READY %s' % BIG, flush=True)
            return 0
        if age > 0 and age < 150 and int(time.time() - t0) > 40:
            # 重启前生成的码还没过期，内核会继续用它（png 不再重写）
            print('export (still-valid old png, %ds): %s' % (age, export()), flush=True)
            print('QR READY %s' % BIG, flush=True)
            return 0
        time.sleep(4)

    print('!!! %d 秒内没拿到活码' % WAIT, flush=True)
    return 3


if __name__ == '__main__':
    sys.exit(main())
