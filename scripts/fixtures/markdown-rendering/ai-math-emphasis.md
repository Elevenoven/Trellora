# Leiden 算法：模块度

Leiden 算法通过**迭代优化模块度（Modularity） **来识别图中的紧密连接节点群。
主要阶段包括**局部移动（Local Moving）**、**聚合（Aggregation）**和**细化（Refinement）**。

优化的目标函数是模块度 $Q$。公式：$$ Q = \frac{1}{2m} \sum_{i,j} \left[ A_{ij} - \frac{k_i k_j}{2m} \right] \delta(c_i, c_j) $$ 其中：

- $A_{ij}$ 是邻接矩阵元素。
- $k_i, k_j$ 是节点 $i, j$ 的度数。
- $m$ 是总边数。
- $\delta(c_i, c_j)$ 是克罗内克函数，当节点 $i$ 和 $j$ 在同一社区时为 1，否则为 0。

$$
Q = \frac{1}{2m} \sum_{i,j} A_{ij}
$$

另一种写法：\(x^2 + y^2 = z^2\)。

\[
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
\]

| 项目 | 内容 |
| --- | --- |
| 加粗 | ** 模块度 ** |
| 公式 | $Q > 0$ |

社区发现结果可继续用于图谱检索。
