"""把 server/desk 的控制页打成 Android APK。

只有一台机器在用的东西，不值得装 Android Studio。这里用 SDK 里那几个
命令行工具手工走一遍 aapt2 -> javac -> d8 -> zipalign -> apksigner，
产出 dist/desk.apk。

前置（tools/setup-android.py 会自动装）：
    android/sdk/android-14/        build-tools 34
    android/sdk/android-34/android.jar
    android/sdk/jdk-17*/           只跑 d8 和 apksigner（JDK 8 跑不了 d8）

用法：
    python tools/build-apk.py                 # 用 .data/config.json 里的 token
    python tools/build-apk.py --token XXX     # 换口令（换手机时用）
    python tools/build-apk.py --base http://1.2.3.4   # 换服务器地址
"""
import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AND = os.path.join(ROOT, "android")
SDK = os.path.join(AND, "sdk")
BUILD = os.path.join(AND, "build")
OUT = os.path.join(ROOT, "dist")
KS = os.path.join(AND, "keystore.jks")
KS_PASS = "deskpet2026"
KS_ALIAS = "desk"
PKG = "cloud.xingyan.desk"


def die(msg):
    print("\n[失败] " + msg)
    sys.exit(1)


def find_bt():
    cands = sorted(glob.glob(os.path.join(SDK, "android-*")))
    for c in cands:
        if os.path.isfile(os.path.join(c, "aapt2.exe")) or os.path.isfile(os.path.join(c, "aapt2")):
            return c
    die("找不到 build-tools，先跑 python tools/setup-android.py")


def find_jar():
    for p in [os.path.join(SDK, "android-34", "android.jar")]:
        if os.path.isfile(p):
            return p
    hits = glob.glob(os.path.join(SDK, "android-*", "android.jar"))
    if hits:
        return sorted(hits)[-1]
    die("找不到 android.jar，先跑 python tools/setup-android.py")


def find_jre():
    """d8 是 class 55 字节码，JDK 8 跑不动，必须用 17。"""
    for p in sorted(glob.glob(os.path.join(SDK, "jdk-*", "bin", "java.exe"))):
        return p
    for p in sorted(glob.glob(os.path.join(SDK, "jdk-*", "bin", "java"))):
        return p
    # 系统里也许已经有 11+
    for name in ("java", "java.exe"):
        p = shutil.which(name)
        if p:
            return p
    die("找不到 Java 11+（d8 需要），先跑 python tools/setup-android.py")


def find_javac():
    for name in ("javac", "javac.exe"):
        p = shutil.which(name)
        if p:
            return p
    die("找不到 javac，装个 JDK 8 即可（只用来编译，不用它跑 d8）")


def run(args, cwd=AND, capture=False):
    shown = " ".join(os.path.basename(args[0]) if i == 0 else str(a) for i, a in enumerate(args))
    if len(shown) > 150:
        shown = shown[:147] + "..."
    print("  $ " + shown)
    r = subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    txt = r.stdout.decode("utf-8", "replace").strip()
    if r.returncode != 0:
        print(txt)
        die("命令失败：%s (exit %d)" % (os.path.basename(args[0]), r.returncode))
    if txt and not capture:
        for line in txt.splitlines()[:12]:
            print("    " + line)
    return txt


def load_token(args):
    if args.token:
        return args.token
    cfg_path = os.path.join(ROOT, ".data", "config.json")
    if os.path.isfile(cfg_path):
        try:
            cfg = json.load(open(cfg_path, encoding="utf-8"))
            r = cfg.get("remote") or {}
            tok = r.get("pageToken") or r.get("token")
            if tok:
                return tok
        except Exception as e:
            print("  读配置失败：%s" % e)
    die("没有 token。用 --token 指定，或在 .data/config.json 的 remote.token 里配好")


def gen_java(url, host):
    d = os.path.join(BUILD, "gen", "cloud", "xingyan", "desk")
    os.makedirs(d, exist_ok=True)
    src = (
        "package cloud.xingyan.desk;\n\n"
        "/** 构建时生成，含口令，不进仓库（tests/make-icons 都不碰这个文件）。 */\n"
        "public final class Gen {\n"
        '    public static final String HOST = "%s";\n'
        '    public static final String URL = "%s";\n'
        "    private Gen() {}\n"
        "}\n" % (host, url)
    )
    with open(os.path.join(d, "Gen.java"), "w", encoding="utf-8", newline="\n") as f:
        f.write(src)


def ensure_keystore(keytool):
    if os.path.isfile(KS):
        return
    print("  生成签名密钥（只需一次）")
    run([keytool, "-genkeypair", "-keystore", "keystore.jks", "-storetype", "JKS",
         "-alias", KS_ALIAS, "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
         "-storepass", KS_PASS, "-keypass", KS_PASS,
         "-dname", "CN=Secretary Desk, OU=Personal, O=Personal, C=CN"], capture=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", help="手机端口令，默认读 .data/config.json")
    ap.add_argument("--base", help="服务器根地址，例如 http://8.139.252.197")
    ap.add_argument("--path", default="/desk/", help="控制页路径")
    ap.add_argument("--keep", action="store_true", help="保留中间产物")
    args = ap.parse_args()

    bt = find_bt()
    android_jar = find_jar()
    java17 = find_jre()
    javac = find_javac()
    is_win = os.name == "nt"
    exe = ".exe" if is_win else ""
    aapt2 = os.path.join(bt, "aapt2" + exe)
    zipalign = os.path.join(bt, "zipalign" + exe)
    d8_jar = os.path.join(bt, "lib", "d8.jar")
    signer_jar = os.path.join(bt, "lib", "apksigner.jar")
    for p in (aapt2, zipalign, d8_jar, signer_jar):
        if not os.path.isfile(p):
            die("build-tools 不完整，缺 " + os.path.basename(p))

    token = load_token(args)
    base = (args.base or "http://8.139.252.197").rstrip("/")
    if not re.match(r"^https?://", base):
        die("--base 需要带 http:// 前缀")
    path = args.path if args.path.startswith("/") else "/" + args.path
    host = base
    url = "%s%s?t=%s" % (base, path, token)

    print("\n构建 %s" % PKG)
    print("  地址 %s" % url)
    print("  工具 %s" % os.path.basename(bt))

    if os.path.isdir(BUILD):
        shutil.rmtree(BUILD)
    os.makedirs(BUILD)
    os.makedirs(OUT, exist_ok=True)

    # 版本号跟着提交数走，装完能看到是不是最新的
    try:
        vcode = int(subprocess.check_output(["git", "rev-list", "--count", "HEAD"], cwd=ROOT)
                    .decode().strip())
    except Exception:
        vcode = 1
    vname = "1.%d" % vcode

    print("\n[1/6] 生成入口常量")
    gen_java(url, host)

    print("[2/6] 编译资源")
    run([aapt2, "compile", "--dir", "res", "-o", "build/res.zip"])

    print("[3/6] 链接（生成 AndroidManifest + resources.arsc）")
    run([aapt2, "link", "-o", "build/base.apk", "-I", os.path.relpath(android_jar, AND),
         "--manifest", "AndroidManifest.xml", "build/res.zip",
         "--java", "build/gen",
         "--min-sdk-version", "21", "--target-sdk-version", "34",
         "--version-code", str(vcode), "--version-name", vname])

    print("[4/6] 编译 Java + 转 dex")
    srcs = [os.path.join("src", "cloud", "xingyan", "desk", "MainActivity.java"),
            os.path.join("build", "gen", "cloud", "xingyan", "desk", "Gen.java"),
            os.path.join("build", "gen", "cloud", "xingyan", "desk", "R.java")]
    for s in srcs:
        if not os.path.isfile(os.path.join(AND, s)):
            die("源码缺失 " + s)
    os.makedirs(os.path.join(BUILD, "classes"), exist_ok=True)
    # 用 -classpath 而不是 -bootclasspath：后者会顶掉 JDK 的 rt.jar，
    # 连 java.lang.Object 都找不到
    run([javac, "-encoding", "UTF-8", "-source", "8", "-target", "8",
         "-classpath", os.path.relpath(android_jar, AND),
         "-d", "build/classes"] + srcs)

    os.makedirs(os.path.join(BUILD, "dex"), exist_ok=True)
    # d8 8.x 不认目录参数（会把目录当文件，报 Unsupported source file type），
    # 只能自己把 class 一个个列出来
    class_files = []
    for base, _, files in os.walk(os.path.join(BUILD, "classes")):
        for fn in files:
            if fn.endswith(".class"):
                class_files.append(os.path.relpath(os.path.join(base, fn), AND))
    if not class_files:
        die("没有编译出任何 class")
    print("  %d 个 class" % len(class_files))
    run([java17, "-cp", os.path.abspath(d8_jar), "com.android.tools.r8.D8",
         "--release", "--min-api", "21", "--lib", os.path.relpath(android_jar, AND),
         "--output", "build/dex"] + class_files, cwd=AND)

    print("[5/6] 打包 + 对齐")
    dex = os.path.join(BUILD, "dex", "classes.dex")
    if not os.path.isfile(dex):
        die("d8 没产出 classes.dex")
    with zipfile.ZipFile(os.path.join(BUILD, "base.apk"), "a", zipfile.ZIP_DEFLATED) as z:
        z.write(dex, "classes.dex")
    run([zipalign, "-f", "4", "build/base.apk", "build/aligned.apk"])

    print("[6/6] 签名")
    ensure_keystore(shutil.which("keytool") or "keytool")
    final = os.path.join(OUT, "desk.apk")
    if os.path.exists(final):
        os.remove(final)
    run([java17, "-jar", os.path.abspath(signer_jar), "sign",
         "--ks", "keystore.jks", "--ks-pass", "pass:" + KS_PASS,
         "--key-pass", "pass:" + KS_PASS, "--ks-key-alias", KS_ALIAS,
         "--min-sdk-version", "21",
         "--out", os.path.relpath(final, AND), "build/aligned.apk"], cwd=AND, capture=True)

    print("\n验证")
    v = run([java17, "-jar", os.path.abspath(signer_jar), "verify", "--print-certs",
             os.path.relpath(final, AND)], cwd=AND, capture=True)
    for line in v.splitlines()[:4]:
        print("  " + line)
    bad = run([aapt2, "dump", "badging", os.path.relpath(final, AND)], capture=True)
    for line in bad.splitlines():
        if line.startswith(("package:", "launchable-activity:", "application-label", "sdkVersion", "targetSdkVersion")):
            print("  " + line)

    size = os.path.getsize(final) / 1024.0 / 1024.0
    print("\n完成 %s  (%.2f MB)" % (final, size))
    print("  版本 %s (%d)   sha256 %s" % (vname, vcode, _sha256(final)))
    if not args.keep:
        shutil.rmtree(BUILD, ignore_errors=True)
    return 0


def _sha256(p):
    import hashlib
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


if __name__ == "__main__":
    sys.exit(main())
