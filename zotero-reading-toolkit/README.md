# Zotero Reading Toolkit

这是一个面向 Zotero 8–10 的本地轻量插件。它提供语义标注类型和阅读状态标签互斥功能。

## 功能

### 语义标注类型

选中 PDF 文字后，原生颜色按钮会排成一行；每个类型的色块在上，名称竖排显示：

| Zotero 颜色 | 默认类型 |
| --- | --- |
| 黄色 | 背景 |
| 红色 | 质疑/重要 |
| 绿色 | 方法 |
| 蓝色 | 结论 |
| 紫色 | 创新 |
| 洋红色 | 不足 |
| 橙色 | 待办 |
| 灰色 | 引用/旁支 |

- 在“编辑 → 设置 → 阅读工具箱”中可以修改所有名称。
- 修改已有标注的颜色时，颜色菜单同样显示语义名称。
- 默认自动给新建或改色的标注添加 `标注类型/名称` 标签，并移除原来的同前缀标签。
- 关闭“自动同步标签”后，只保留界面名称，不修改标注标签。
- 底层仍使用 Zotero 原生颜色和标签，标注本身可以正常同步；自定义名称保存在本机偏好设置中。

### 阅读状态

- `未读`、`在读`、`完成` 三个标签互斥。

## 数据与隐私

- 插件不访问网络，也不读取 PDF 正文。
- 旧版本生成的 `reading-tracker-local.json` 不再读取或修改，并会保留在 Zotero 配置目录中。
- Zotero 要求插件声明 HTTPS 更新地址；本地版本使用 IANA 保留的 `.invalid` 域名，并应关闭自动更新。

## 构建和测试

```powershell
node --check .\bootstrap.js
node --check .\content\core.js
node --check .\content\readingToolkit.js
node .\tests\core.test.js
node .\tests\integration.test.js
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Build.ps1
```

发布包生成在 `releases/`。安装时打开 Zotero 的“工具 → 插件”，选择“从文件安装插件”，然后选择 `.xpi`。

## 第三方说明

语义颜色菜单的接入方式参考了 MIT 许可的 Zotero Highlight Color Descriptions。详情见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## v0.3.0 阅读笔记汇总

在文献列表选中文献或 PDF 附件，打开“工具 → 按语义汇总选中文献标注…”。插件按当前自定义语义名称分组，创建新的原生 Zotero 笔记，包含标注文字、评论、页码和返回标注链接。图片标注保留跳转入口，不嵌入截图。

同一批选择中的文献和附件会去重；选择文献的某个附件时汇总该文献全部 PDF。多篇笔记使用同一事务保存，只读库会拒绝操作。每次执行创建新笔记，不覆盖已有笔记。独立 PDF 的笔记保存在同一文献库和分类中。

新增测试：`node tests/notes.test.js`。自动测试覆盖分组、转义、去重、群组链接和只读库；真实 Zotero 窗口中的交互仍需安装新版后验收。
