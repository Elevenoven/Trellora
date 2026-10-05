from __future__ import annotations


class StageError(Exception):
    def __init__(self, code: str, message: str, retryable: bool, diagnostic: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.diagnostic = diagnostic


class StageCancelled(StageError):
    def __init__(self) -> None:
        super().__init__('STAGE_CANCELLED', '文档处理任务已取消。', True)
