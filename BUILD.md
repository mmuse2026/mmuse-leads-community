# 构建缪斯获客管理社区版 Windows x64 测试版

源码包含工作台前端、后端、启动器和网页背调程序。第三方运行环境从相同版本的 Windows 包提取，业务配置和客户库在构建时自动初始化为空。

1. 在 Windows x64 安装 [Node.js 22.22.3](https://nodejs.org/dist/v22.22.3/)，确保终端可以运行 `node.exe` 和 `npm.cmd`。
2. 将源码包与 [v0.2.0-beta.1 Windows 运行包](https://github.com/mmuse2026/mmuse-leads-community/releases/tag/v0.2.0-beta.1) 解压到两个不同的可写目录。运行包的 SHA-256 是 `6b3e872dd9c0ed27f17ecb0b855dc018eb888456080893dd8748580b1cf5d1d1`。
3. 打开命令提示符并进入源码目录。执行下方命令，参数填写解压后的 Windows 运行包目录。首次构建需要联网安装锁定的依赖。

```batch
Build-Source.cmd "C:\Downloads\MMUSE Windows"
```

构建完成后，在源码目录双击 `Start-MMUSE.cmd`。启动器默认使用 `http://127.0.0.1:48396/`。后续启动请使用同一目录，这样可以读取本地数据。

源码构建仅从 Windows 包复制 `node.exe` 和 `runtime/crawl`。如需另做空白分发，请从新解压的源码目录构建，并在首次启动之前打包，确保客户数据和用户设置为空。
