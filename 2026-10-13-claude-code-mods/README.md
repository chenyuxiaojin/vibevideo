# Claude Code Mods：我自己在用的 8 个 mod

视频里提到的 mod，我自己每天都在用的这 8 个都放在 [`mods/`](mods/) 里，免费拿去用。刘海上那块面板是另一个原生 App，在 [cyxj-notch](https://github.com/chenyuxiaojin/cyxj-notch) 仓库。

| mod | 做什么 | 要不要配置 |
|---|---|---|
| [file-tree](mods/file-tree/) | 右边开一个 VS Code 样式的文件树：文件夹能点开收起，点文件能预览；Claude 正在读的文件闪蓝、正在改的闪黄，改完保存变绿打勾 | 不用 |
| [polish](mods/polish/) | `/polish 一句话需求`：先问你 3 个问题，再把这句话写成详细提示词，左边原话、右边提示词，能复制也能直接运行 | 不用 |
| [handoff](mods/handoff/) | `/clear` 之后，输入框上方显示「刚才在做……」，回一个「接」就接着聊；`/handoff` 另写一份交接稿给新对话接手 | 不用 |
| [quota-status](mods/quota-status/) | 状态栏显示 5 小时 / 本周额度、本对话花了多少、缓存还热几分钟；快用完、缓存快凉的时候弹提醒 | 不用（额度要 Pro 或 Max 订阅） |
| [task-progress](mods/task-progress/) | 给 Claude 加一个报进度的工具，多步任务每做完一步，输入框上方的进度条走一格 | 不用 |
| [todo-pane](mods/todo-pane/) | `/daiban` 打开侧边面板，列出你待办文件里「正在推进」和「待收尾」的事 | 要设 `NOTCH_TODO_LOG` |
| [publish-pulse](mods/publish-pulse/) | 状态栏显示离上次发片几天（红黄绿灯）和下一次定时发布 | 要设 `NOTCH_PUBLISH_ROOT` |
| [version-board](mods/version-board/) | `/banben` 侧边面板：后台 `claude -p` 开的预览版本、端口、档位、跑完没；一次超过 3 个就拦下 | 不用 |

后面 5 个会顺手往 `~/.claude/notch/` 写小 JSON 给刘海台读；不装刘海台也照样能用。todo-pane 和 publish-pulse 是照我自己的工作流写的，读的是我的待办和发布记录格式，你直接装多半没数据，可以当参考，或者让 Claude 照着改成你的。

## 怎么装

**先看源码。** mod 不在沙箱里，它拥有和你终端一样的权限，能读写文件、联网、跑别的程序，还能替你按「同意」。装别人的 mod 之前，先把代码看一遍，或者让 Claude 帮你看。

1. 把这个仓库下载下来。
2. 只想在这一次对话里试一下：`claude --plugin-dir 2026-10-13-claude-code-mods/mods/polish`
3. 想每次都自动加载：在 `~/.claude/settings.json` 里加上下面这段，路径换成你自己的，多个 mod 用英文冒号隔开：

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/mods/file-tree:/path/to/mods/polish:/path/to/mods/handoff"
  }
}
```

需要 Claude Code v2.1.287 及以上（mod 从这一版起默认开启）。装之前可以先跑一遍 `claude plugin validate <mod 文件夹>` 检查格式。

## 视频里用的提示词

file-tree 和 polish 是在视频里现场让 Claude Code 写的，原话如下：

> 做一个 mod：在右边开一个文件树面板，列出当前文件夹里的所有文件。你正在读或者正在改哪个文件，哪个就闪一下；改完保存好的文件变成绿色。

> 这个文件树有点太丑了，能不能做成 vscode 那样的文件树？然后还可以预览的那种

> 做一个 mod：加一个 /polish 命令。我在后面写一句很简单的需求，它先弹出一个面板问我 3 个问题，我答完以后，左边显示我的原话，右边显示帮我写好的详细提示词，下面放「复制」和「直接运行」两个按钮。

想找到适合你自己的 mod，把这段话发给你项目文件夹里的 Claude Code（20 次可以改成 50 次、100 次）：

> 看看我平时是怎么用 Claude Code 的：读我最近 20 次对话，找出三样东西——我老是让你做的事、我常用的命令、我怎么检查你的活。然后推荐 5 个能帮我省事的 mod。先给我看点子，我没选之前什么都别做。

handoff 就是我照这段话跑出来的点子之一做的。

## 一个小坑

让 Claude 写 mod 的时候，提醒它斜杠命令的名字别用中文，中文命令名目前会注册失败。

## 许可

`mods/` 里的代码用 MIT 许可，见同目录的 [LICENSE](LICENSE)。
