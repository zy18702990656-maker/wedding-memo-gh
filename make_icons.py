#!/usr/bin/env python3
"""生成 iOS 主屏幕图标：天蓝渐变满幅 + 白色爱心。

关键：必须完全不透明、铺满整幅。
iOS 的 apple-touch-icon 不支持 alpha 通道，透明区域会被合成到黑色背景上，
桌面图标四角就会出现黑块。圆角交给 iOS 自己裁，我们不画圆角、不留透明。
"""
import math
import struct
import zlib


def lerp(a, b, t):
    return a + (b - a) * t


def heart_inside(x, y):
    """标准心形隐函数，(x, y) 为归一化坐标"""
    xx = x * x
    yy = y * y
    return (xx + yy - 1) ** 3 - xx * (y ** 3) <= 0


def render(size):
    ss = 3                      # 爱心边缘超采样
    scale = size * 0.30
    cx = size / 2.0
    cy = size * 0.47
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            # 背景渐变：左上亮 → 右下深
            t = (x / size) * 0.45 + (y / size) * 0.55
            br = int(lerp(0x3A, 0x07, t))
            bg = int(lerp(0x9C, 0x5C, t))
            bb = int(lerp(0xE8, 0xA8, t))

            heart = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    hx = (x + (sx + 0.5) / ss - cx) / scale
                    hy = -(y + (sy + 0.5) / ss - cy) / scale
                    if heart_inside(hx, hy):
                        heart += 1.0
            heart /= ss * ss

            row += bytes((
                int(lerp(br, 255, heart)),
                int(lerp(bg, 255, heart)),
                int(lerp(bb, 255, heart)),
            ))
        rows.append(bytes(row))
    return rows


def write_png(path, size):
    rows = render(size)
    raw = b''.join(b'\x00' + r for r in rows)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    # 颜色类型 2 = RGB（无 alpha 通道，从格式上保证不可能透明）
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)
    print('wrote', path, size, '(RGB, 无 alpha)')


if __name__ == '__main__':
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    write_png(os.path.join(here, 'icon-180.png'), 180)
    write_png(os.path.join(here, 'icon-512.png'), 512)
