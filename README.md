# MMUSE 获客管理社区版

## Windows x64 便携测试版

[下载 v0.2.0-beta.1](https://github.com/mmuse2026/mmuse-leads-community/releases/tag/v0.2.0-beta.1)

将 ZIP 解压到可写目录，双击 `Start-MMUSE.cmd`。运行环境随包提供，首次启动使用空白客户库，无需注册或登录。后续启动请使用同一解压目录，以便读取保存的资料。

可查询企业、录入和去重客户、背调网页、管理联系人、准备开发邮件及跟进。使用模型、联系人和邮件服务时，请在工具内配置自己的服务账号。发布页提供 SHA-256 校验文件。

[下载 v0.2.0-beta.1 源码 ZIP](https://github.com/mmuse2026/mmuse-leads-community/releases/download/v0.2.0-beta.1/MMUSE-Leads-Community-0.2.0-beta.1-Source.zip)。解压后查看 `BUILD.md`，可用 `Build-Source.cmd` 构建前后端并接入同版本的 Windows 运行环境。

## v0.1.x 源码

仓库主分支内的 Python 程序和下方使用说明对应 v0.1.x。

在本机整理外贸客户线索、记录跟进并检查邮箱。首次启动会创建空白客户库，可以直接开始录入，无需注册或登录。

## 怎么使用

1. 安装 Python 3.10 或更新版本。
2. 到 [v0.1.1 发布页](https://github.com/mmuse2026/mmuse-leads-community/releases/tag/v0.1.1) 下载并解压 ZIP。Windows 双击 `Start-MMUSE.cmd`，或在解压目录运行 `python app.py`。
3. 浏览器打开本机客户列表。点击「新建客户」录入一条线索，或使用 CSV 模板导入一批客户。关闭运行窗口可退出，再次启动可继续处理已有资料。

## 功能

| 功能 | 用法 |
| --- | --- |
| 客户资料 | 录入公司、网站、联系人和邮箱。网站域名或邮箱重复时会提示。 |
| 跟进记录 | 设置客户阶段和下次跟进日期，记录每次沟通。可按关键词、阶段或到期情况筛选。 |
| 邮箱验证 | 打开客户详情检查邮箱格式。在 Windows 上也可查询域名 MX。查询只交给系统 DNS 解析器处理域名，结果用于判断域名邮件记录。 |
| CSV 导入导出 | 使用 UTF-8 CSV 导入线索，重复项自动跳过。可导出筛选后的客户列表。 |

Windows 默认将数据存到 `%LOCALAPPDATA%\MMUSE Leads Community`。可以用 `python app.py --data-dir "目录路径"` 指定数据目录。

## 联系我们

- [MMUSE 官网](https://forms.mmues.com/)
- [联系邮箱 mmuse2026@outlook.com](mailto:mmuse2026@outlook.com)

## 许可证

[MIT](LICENSE)
