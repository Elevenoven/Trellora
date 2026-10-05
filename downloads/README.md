# Trellora 下载与发行文件

本目录存放从当前源码构建的 Windows x64 发行文件。版本：**1.0.0**。

| 文件 | 用途 |
| --- | --- |
| `Trellora-1.0.0-setup-x64.exe` | NSIS 安装版，可选择安装目录 |
| `Trellora-1.0.0-portable-x64.exe` | 免安装版，直接运行 |
| `SHA256SUMS.txt` | 两个发行文件的 SHA-256 校验值 |
| `release-manifest.json` | 文件大小、版本、运行时和签名状态 |
| `package-verification.json` | 实际免安装包的隔离运行验收结果和未验证项 |

## 用户下载

- [Windows x64 安装版](Trellora-1.0.0-setup-x64.exe?raw=true)
- [Windows x64 免安装版](Trellora-1.0.0-portable-x64.exe?raw=true)
- [全部发行版本](https://github.com/Elevenoven/Trellora-plus/releases)

将本目录随源码上传到 GitHub 后，README 中的相对下载链接即可使用。本地打包完成不代表已经在线发布。

## 上传 GitHub

将本目录的两个 `.exe`、说明、校验值和清单一起通过 Git 提交并推送到仓库。`.gitignore` 已允许本目录的 `.exe`；其他构建目录仍被忽略。本次两个包各约 89 MiB，低于 GitHub 普通仓库的 100 MiB 单文件限制；浏览器上传单文件限制为 25 MiB，因此安装包应通过 Git 上传。参见 [GitHub 文件上传说明](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)。

也可以在 **Releases → Draft a new release** 中创建 `v1.0.0` 标签，将本目录的两个 `.exe`、`SHA256SUMS.txt` 和 `release-manifest.json` 上传为附件，再发布 Release。以后若安装包超过 100 MiB，应使用 Releases 分发并更新 README 下载链接。

安装包下载使用相对路径，随仓库移动仍可使用；发布到其他仓库时，需要更新中英文 README 与本文中的 Releases 仓库链接。

## 校验下载文件

```powershell
Get-FileHash .\Trellora-1.0.0-setup-x64.exe -Algorithm SHA256
Get-FileHash .\Trellora-1.0.0-portable-x64.exe -Algorithm SHA256
```

将结果与 `SHA256SUMS.txt` 比较。TypeScript、ESLint、Python 单元测试和包内模块检查已通过；实际免安装包已验证启动、随包 Worker、笔记保存及索引、正常关闭与重启后的内容保留。详细结果见 `package-verification.json`。

本次文件未进行数字签名；干净 Windows 环境以及安装版的安装、升级、卸载流程尚未验收。
