# @localehub/worker

BullMQ Worker。队列：`qa`、`import-export`、`notifications`、`ai`。

```bash
node apps/worker/dist/main.js
```

## 幂等性

`qa.run` 任务的实现是「从数据库重新计算」而非增量累加：删除该批次条目的 OPEN 问题后重新写入，
因此崩溃重试不会产生重复问题。其他队列目前是占位实现，返回值明确标记未配置后端，
不会伪装成已执行。

## 观测

- 失败与完成事件写入结构化日志（含 job id）。
- API 侧 `GET /api/v1/system/queues` 暴露各队列深度。
