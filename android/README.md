# android/ —— 手机端 APK

把 `server/desk` 的控制页套进一个 WebView 壳，装到手机上就是一个 App。
壳子只有 180 行 Java，不做任何原生 UI：页面改了不用动这里，重新打一次包就行。

## 构建

```bash
python tools/setup-android.py    # 第一次：下工具链（约 160MB，只做一次）
python tools/build-apk.py        # 每次：产出 dist/desk.apk
```

口令从 `.data/config.json` 的 `remote.pageToken` 读，不写死在仓库里。
换口令 / 换服务器：

```bash
python tools/build-apk.py --token 新口令 --base http://1.2.3.4
```

## 改了控制页之后

`server/desk/public/index.html` 是服务端下发的，改完部署就生效，**不用重新打包**。
只有这几种情况才需要重打：

- 换服务器地址或口令
- 换图标、换名字
- 改 `MainActivity.java` 本身

## 装到手机

1. 手机浏览器打开 `http://你的地址/desk/?t=口令`
2. 页面最底部点「装成 App」（服务端 `/desk.apk` 直接下发）

也可以把 `dist/desk.apk` 传到手机点开。第一次装要允许「安装未知来源应用」。

## 签名密钥

`android/keystore.jks`，口令 `deskpet2026`，别名 `desk`，已 gitignore。

**别删**。换签名的新 APK 覆盖装会报「应用未安装」，只能先卸载再装，
那样 npm 里存的登录态之类都会丢。

## 结构

```
android/
  AndroidManifest.xml        包名 cloud.xingyan.desk，minSdk 21，targetSdk 34
  src/cloud/xingyan/desk/    MainActivity.java（唯一源文件）
  res/                       图标，由 tools/make-icons.py 从 icon-512.png 生成
  sdk/                       工具链（build-tools 34 + android-34 + JRE17），gitignore
  build/                     中间产物，gitignore
```

## 为什么不用 Gradle

只为打一个 250KB 的壳，装 Android Studio 不值当。`tools/build-apk.py` 直接
串命令行工具：`aapt2 compile` → `aapt2 link` → `javac` → `d8` → `zipalign` → `apksigner`。

踩过的四个坑（改脚本时别踩回去）：

| 现象 | 原因 |
|---|---|
| d8 报 `Unsupported source file type` | d8 8.x 不认目录参数，必须把 `.class` 一个个列出来 |
| javac 报找不到 `java.lang.Object` | 用了 `-bootclasspath`，它会把 JDK 的 rt.jar 顶掉，要改 `-classpath` |
| aapt2 报 `does not override an existing resource` | 资源要作为位置参数传，`-R` 是 overlay 语义 |
| 打出来的 versionCode 永远是 1 | manifest 里写了 `versionCode` 时 `--version-code` 不生效，已从 manifest 移除 |

另外本机只有 JDK 8，而 d8 是 class 55 字节码跑不起来，所以额外下一个 JRE 17
专门伺候 d8 和 apksigner；javac 仍然用 JDK 8 编 target 8。
