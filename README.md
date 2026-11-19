# MMUSE 获客管理社区版

在本机整理外贸客户线索、记录跟进并检查邮箱。首次启动会创建空白客户库，可以直接开始录入，无需注册或登录。

## 怎么使用

1. 安装 Python 3.10 或更新版本。
2. 到 [Releases](https://github.com/kenkowang6-lgtm/mmuse-leads-community/releases/latest) 下载并解压 ZIP。Windows 双击 `Start-MMUSE.cmd`，或在解压目录运行 `python app.py`。
3. 浏览器打开本机客户列表。点击「新建客户」录入一条线索，或使用 CSV 模板导入一批客户。关闭运行窗口可退出，再次启动可继续处理已有资料。

## 功能

| 功能 | 用法 |
| --- | --- |
| 客户资料 | 录入公司、网站、联系人和邮箱。网站域名或邮箱重复时会提示。 |
| 跟进记录 | 设置客户阶段和下次跟进日期，记录每次沟通。可按关键词、阶段或到期情况筛选。 |
| 邮箱验证 | 打开客户详情检查邮箱格式。在 Windows 上也可查询域名 MX。查询只交给系统 DNS 解析器处理域名，结果用于判断域名邮件记录。 |
| CSV 导入导出 | 使用 UTF-8 CSV 导入线索，重复项自动跳过。可导出筛选后的客户列表。 |

Windows 默认将数据存到 `%LOCALAPPDATA%\MMUSE Leads Community`。可以用 `python app.py --data-dir "目录路径"` 指定数据目录。

## 许可证

[MIT](LICENSE)
