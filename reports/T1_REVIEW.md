# T1 独立审查

两名真实 Codex 原生子代理并行只读研究，各自在 Root 实现后仅进行一次定向复审；未编辑文件、未重复执行测试。Root 是唯一实现者。

## trajectory / quality review

`t1_quality_reviewer` 首轮指出：现有 Loop 是固定二分门控，完成与证据不足由主机决定；若把完成状态当作模型输出，或把 factCount 当作事实可信度，会污染训练标签。任务 ID、来源哈希和最终结果也会泄漏。

最终定向审查认为没有阻断的数据质量问题：仅第二轮实际行动、独立 prefix-only oracle、T0 证据不足标签保留、金融事实未评价、规范化去重与训练就绪阻断符合研究范围。发现一处异步拒绝断言缺少 await，Root 已补齐，没有改变断言内容。

## integrity review

`t1_integrity_reviewer` 首轮要求：不能信任任意 T0 JSON；必须检查当前授权、已封存 capture 成员关系及签名；新用途许可必须绑定实际输出；使用私有存储，保留旧测试门槛。

最终复审发现一个 P2：主机许可回调返回可变对象，校验后若保留原引用，异步期间的修改可能进入签名导出。Root 新增可重复的负例，真实出现 **13/14**，断言为“published grant must be an immutable snapshot of approved fields”，实际 `allow:false`。失败运行 `run-NDrXrb` 的 TAP、签名产物、源码副本和原始数据全部保留在受保护目录。

修复为：许可回调返回后立即深拷贝，再验证、保存其快照。保持新断言原样，修复后复测。Root 同时补充 unknown eval 来源不因标签过滤而失去 split 约束的验证，并明确跨批次隔离尚未实现。发布前权限再次撤销的负例也要求零最终文件。

审查没有宣称执行过测试，也没有证明真实金融事实、模型研究收益、计费或法律权利。全部执行证据由 Root 生成，见 [验收报告](T1_ACCEPTANCE.md)。
