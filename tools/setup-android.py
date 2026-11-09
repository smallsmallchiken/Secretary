"""一次性准备 APK 构建工具链（约 160MB，放在 android/sdk/，已在 gitignore）。

不装 Android Studio。只要四样东西：
    build-tools 34   aapt2 / zipalign / d8 / apksigner
    android-34       android.jar（编译用的 API 桩）
    JRE 17           d8 是 class 55 字节码，本机 JDK 8 跑不动它

下载源是 Google 官方仓库；如果直连慢，脚本会提示换镜像（腾讯云的
AndroidSDK 目录有同样的 build-tools 包）。

用法：python tools/setup-android.py
"""
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SDK = os.path.join(ROOT, "android", "sdk")

ITEMS = [
    {
        "name": "build-tools 34（aapt2 / zipalign / d8 / apksigner）",
        "url": "https://dl.google.com/android/repository/build-tools_r34-windows.zip",
        "zip": "bt.zip",
        "probe": ["android-14/aapt2.exe", "android-14/lib/d8.jar", "android-14/lib/apksigner.jar"],
    },
    {
        "name": "android-34（android.jar）",
        "url": "https://dl.google.com/android/repository/platform-34-ext7_r03.zip",
        "zip": "platform.zip",
        "probe": ["android-34/android.jar"],
    },
    {
        "name": "JRE 17（d8 和 apksigner 要用）",
        "url": "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jre/hotspot/normal/eclipse?project=jdk",
        "zip": "jre17.zip",
        "probe_glob": ("jdk-17", os.path.join("bin", "java.exe")),
    },
]


def have(item):
    if "probe" in item:
        return all(os.path.isfile(os.path.join(SDK, p)) for p in item["probe"])
    prefix, tail = item["probe_glob"]
    for d in os.listdir(SDK) if os.path.isdir(SDK) else []:
        if d.startswith(prefix) and os.path.isfile(os.path.join(SDK, d, tail)):
            return True
    return False


def download(url, dest):
    print("  下载 %s" % url)
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        got = 0
        step = 0
        while True:
            buf = r.read(262144)
            if not buf:
                break
            f.write(buf)
            got += len(buf)
            if total:
                pct = got * 100 // total
                if pct // 10 != step:
                    step = pct // 10
                    print("    %3d%%  %.0f/%.0f MB" % (pct, got / 1e6, total / 1e6))
    os.replace(tmp, dest)
    if os.path.getsize(dest) < 100000:
        sys.exit("  下载的文件太小，可能被拦了（%d 字节）" % os.path.getsize(dest))


def main():
    if os.name != "nt":
        sys.exit("这个脚本只处理 Windows 工具包；其他平台请直接装 Android SDK 后改 build-apk.py 的路径")
    os.makedirs(SDK, exist_ok=True)

    todo = [i for i in ITEMS if not have(i)]
    if not todo:
        print("工具链齐全，直接跑 python tools/build-apk.py 即可")
        return 0

    for item in todo:
        print("\n== %s" % item["name"])
        zpath = os.path.join(SDK, item["zip"])
        if os.path.isfile(zpath) and os.path.getsize(zpath) > 100000:
            print("  已有压缩包，跳过下载")
        else:
            try:
                download(item["url"], zpath)
            except Exception as e:
                sys.exit("  下载失败：%s\n  可以手动下载后放到 android/sdk/%s" % (e, item["zip"]))
        print("  解压…")
        with zipfile.ZipFile(zpath) as z:
            z.extractall(SDK)
        os.remove(zpath)

    print("\n校验：")
    ok = True
    for item in ITEMS:
        good = have(item)
        ok = ok and good
        print("  %s %s" % ("OK  " if good else "缺失", item["name"]))
    if not ok:
        sys.exit("有组件没装好，检查 android/sdk 目录")

    java = None
    for d in os.listdir(SDK):
        if d.startswith("jdk-17"):
            java = os.path.join(SDK, d, "bin", "java.exe")
    if java:
        v = subprocess.run([java, "-version"], capture_output=True)
        print("\n  JRE: " + v.stderr.decode("utf-8", "replace").splitlines()[0])
    print("\n好了，现在跑 python tools/build-apk.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
