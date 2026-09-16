# macOS 打开 Glint 的「已损坏 / 无法打开」

Glint 未做 Apple 公证签名。从 GitHub 下载的 app 带有 `com.apple.quarantine` 标记时，可能出现：

> “Glint”已损坏，无法打开。你应该将它移到废纸篓。

**先不要删除应用。**

## 推荐：去掉隔离标记

```bash
# 已安装到「应用程序」时
xattr -dr com.apple.quarantine /Applications/Glint.app
```

若 app 在别的目录：

```bash
xattr -dr com.apple.quarantine /绝对路径/Glint.app
```

然后重新打开。

## 或：系统设置放行

1. 尝试打开 → 出错后选 **取消**
2. **系统设置 → 隐私与安全性**
3. 找到关于 Glint 的拦截提示 → **仍要打开**
4. 再启动应用

## 或：旧系统右键打开

应用程序里右键 Glint → 打开 → 打开（较新系统可能无效，优先用上面两种）。

## 之后仍不想每次处理？

给 app 做本机 ad-hoc 签名（效果有限，部分系统仍可能拦）：

```bash
codesign --force --deep --sign - /Applications/Glint.app
```

正式分发需 Apple Developer 证书 + 公证（notarization），见 Tauri 官方 macOS 代码签名与公证文档。
