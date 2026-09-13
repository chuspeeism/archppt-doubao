# 第三方内容声明

本项目在生成的 HTML 中内联了第三方图标数据。下列声明按各自许可证的要求随本项目一同分发。
图标清单与逐个许可证见 `project/lib/icons/manifest.json`。清单与上游是否一致，
在开发仓 chuspeeism/arch-diagram-ppt-dev 根目录跑 `node scripts/sync-icon-licenses.mjs --check` 校验。

## 一、通用图标（lucide）

`project/lib/icons/generic-icons.mjs` 中的 38 个图标提取自 lucide-static 1.28.0，图形数据与上游一致。

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

其中以下 12 个图标派生自 Feather 项目，适用 MIT 许可证：
`alert-circle`、`arrow-right`、`calendar`、`check`、`clock`、`database`、`lock`、`monitor`、
`search`、`server`、`smartphone`、`x`。

```
The MIT License (MIT)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 二、技术品牌图标（simple-icons）

`project/lib/icons/tech-icons.mjs` 中的 73 个图标提取自 simple-icons 16.28.0，全部为 CC0 1.0。
CC0 是权利放弃声明，不要求署名。

simple-icons 项目整体为 CC0，但其中部分图标带有各自的许可证。本项目**只收录 CC0 的图标**：
凡对商业使用附带条件的（禁止商业使用、要求署名、要求相同方式共享）一律不收录。
按此口径移除的 13 个图标为 `cassandra`、`flink`、`kafka`、`pulsar`、`rocketmq`、`spark`、
`vue`、`angular`、`rust`、`git`、`jenkins`、`javascript`、`java`。
这些技术的名称仍可作为节点标签使用，匹配器会为其配通用图标。

该约束由 `tests/icon-matcher.test.mjs` 的「图标库只含 CC0-1.0 与 ISC 的图标」用例守护，
新增图标时若带其它许可证，测试会失败（测试与下面的脚本都只在开发仓里）。
在开发仓根目录跑 `node scripts/sync-icon-licenses.mjs --check` 核对清单与上游是否一致。

## 三、商标

上述图标中的品牌标识、名称与商标归各自权利人所有。CC0 放弃的是著作权，不涉及商标权
（CC0 1.0 第 4(a) 条明确说明商标权不受该声明影响）。

本项目按指示性使用的方式使用这些标识：图标只出现在用户架构图的节点上，用于标注该节点
所采用的技术，不带品牌字体与配色背景，可通过 `"icons": false` 或 `"icon": false` 关闭。

使用本项目时请遵守：

- 不要把第三方品牌标识用于本项目自身的宣传物料，包括官网、说明文档头图、社交媒体配图、
  应用图标与站点图标；
- 不要给非该品牌的组件配该品牌的标识，这会构成对技术选型的错误陈述；
- 品牌方另有商标使用政策的，以品牌方政策为准；各图标的政策链接记录在 `project/lib/icons/manifest.json`。

## 四、竞品调研素材

竞品调研过程中用第三方生成器产出的页面已移出本仓库（归档在项目上级目录的「资料归档/竞品分析/」），
不随本项目分发。`.gitignore` 已排除该路径。
