# -*- coding: utf-8 -*-
"""通过 HTTP Range 直接从远程 zip 里抽取文件，不下载整个包。

用法：
  python zip_http.py list   <url>                # 列出 zip 内文件
  python zip_http.py get    <url> <成员名> <输出>  # 抽取单个文件
"""
import io
import re
import sys
import urllib.request


class HttpRangeFile(io.RawIOBase):
    """把远程文件伪装成可 seek 的本地文件（zf 需要的接口）。"""

    def __init__(self, url):
        self.url = url
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=60) as r:
            self.length = int(r.headers["Content-Length"])
        self.pos = 0

    def seek(self, offset, whence=0):
        if whence == 0:
            self.pos = offset
        elif whence == 1:
            self.pos += offset
        elif whence == 2:
            self.pos = self.length + offset
        return self.pos

    def tell(self):
        return self.pos

    def _read_range(self, start, end):
        # end 为闭区间
        req = urllib.request.Request(
            self.url, headers={"Range": f"bytes={start}-{end}"})
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read()

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.length - self.pos
        if n == 0 or self.pos >= self.length:
            return b""
        end = min(self.pos + n - 1, self.length - 1)
        data = self._read_range(self.pos, end)
        self.pos += len(data)
        return data

    def readinto(self, b):
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)

    def readable(self):
        return True

    def seekable(self):
        return True


def open_zip(url):
    import zipfile
    f = HttpRangeFile(url)
    return zipfile.ZipFile(io.BufferedReader(f))


def main():
    cmd, url = sys.argv[1], sys.argv[2]
    zf = open_zip(url)
    if cmd == "list":
        infos = zf.infolist()
        # 按名字里的数字排序，方便看
        def key(i):
            m = re.search(r"(\d+)", i.filename)
            return int(m.group(1)) if m else 0
        for i in sorted(infos, key=key):
            print(f"{i.file_size:>10}  {i.filename}")
    elif cmd == "get":
        name, out = sys.argv[3], sys.argv[4]
        with zf.open(name) as src, open(out, "wb") as dst:
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                dst.write(chunk)
        print("saved", out)


if __name__ == "__main__":
    main()
