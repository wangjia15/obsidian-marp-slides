# fonts/ — 本地字体下载说明

`notes.css` 与 `orderflow.css` 两款中文主题通过 `@font-face` 引用了本目录下的字体文件。
这些字体**体积较大（全套约 155MB），未随仓库分发**，请按下表自行下载并放入本目录，
文件名保持与下表一致即可被主题正确加载。

## 字体清单与官方下载地址（全部免费商用）

| 文件名 | 字体 | 用于 | 官方下载 |
|---|---|---|---|
| `LXGWWenKai-Regular.ttf` | 霞鹜文楷 Regular | notes / orderflow 正文（默认已用） | [lxgw/LxgwWenKai Releases](https://github.com/lxgw/LxgwWenKai/releases) |
| `LXGWWenKai-Medium.ttf` | 霞鹜文楷 Medium | notes / orderflow 加粗字面（v1.522 起无 Bold，以 Medium 代替） | 同上 |
| `SmileySans-Oblique.ttf` | 得意黑 斜体 | notes：KPI 大数字（`.kpi .num`）、`.font-title` 工具类 | [atelier-anchor/smiley-sans Releases](https://github.com/atelier-anchor/smiley-sans/releases) |
| `HarmonyOS_Sans_SC_Regular.ttf` | HarmonyOS Sans SC Regular | notes：表头（`table th`）、`.font-hei` 工具类 | [华为开发者 — HarmonyOS Sans](https://developer.huawei.com/consumer/cn/design/harmonyos-symbol/)（需同意其许可协议，见下方"许可"） |
| `HarmonyOS_Sans_SC_Bold.ttf` | HarmonyOS Sans SC Bold | 同上加粗 | 同上 |
| `SourceHanSansSC-Regular.otf` | 思源黑体 SC Regular | notes：`.font-hei` 回退 | [adobe-fonts/source-han-sans Releases](https://github.com/adobe-fonts/source-han-sans/releases)（SubsetOTF/OTF 简体中文子集） |
| `SourceHanSansSC-Bold.otf` | 思源黑体 SC Bold | 同上加粗 | 同上 |
| `SourceHanSerifSC-Regular.otf` | 思源宋体 SC Regular | notes：金句页引用（`section.quote blockquote`）、`.font-song` 工具类 | [adobe-fonts/source-han-serif Releases](https://github.com/adobe-fonts/source-han-serif/releases)（SubsetOTF/OTF 简体中文子集） |
| `SourceHanSerifSC-Bold.otf` | 思源宋体 SC Bold | 同上加粗 | 同上 |

> 下载思源黑体/宋体时注意选 **SC（简体中文）** 子集版本，并按上表重命名为对应的 `SourceHan*.otf` 文件名（发布包里的原始文件名可能带版本号或子集标记）。

## 也可以不下载：装成系统字体

主题里每条 `@font-face` 的 `src` 都是 `local('…')` 优先——如果你已经把字体**安装为系统字体**
（Windows：右键 ttf/otf → "为所有用户安装"；macOS：双击 → 安装），主题会直接命中 `local()`，
无需在本目录放任何文件。

未安装也未下载时的表现：自动回退到字体栈的下一个候选（`KaiTi`/`微软雅黑`/`SimSun` 等），
版式不变，只是字形观感略有差异。

## 许可

- 霞鹜文楷（LXGW WenKai）：SIL Open Font License 1.1
- 得意黑（Smiley Sans）：SIL Open Font License 1.1
- 思源黑体 / 思源宋体（Source Han Sans / Serif）：SIL Open Font License 1.1
- HarmonyOS Sans SC：华为 HarmonyOS Sans Fonts License Agreement（允许随软件再分发，但
  不可单独分发字体本身、需保留许可文件——这也是本目录不放其字体文件、只给下载指引的原因之一。

## 给维护者：如何往本目录放字体（不入库）

`.gitignore` 已忽略本目录下的 `*.ttf` / `*.otf` / `*.woff` / `*.woff2`，直接把下载好的
文件拖进来即可，不会误提交。若将来决定正式分发某款字体，请同时提交其许可文件并从
`.gitignore` 中为该文件单独解除忽略。
