import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline_worker.chunking_models import SourceBlock
from pipeline_worker.chunking_quality import assess_quality, recommend_child_strategies


def block(index: int, text: str, kind: str = 'paragraph') -> SourceBlock:
    return SourceBlock(block_id=f'b-{index}', text=text, order=index, kind=kind)


class ChunkingQualityTests(unittest.TestCase):
    def test_empty_document_is_low_and_recursive(self):
        quality = assess_quality([])
        recommendation = recommend_child_strategies({'childStrategies': [], 'llmEnabled': False}, quality)
        self.assertEqual(quality['level'], 'LOW')
        self.assertFalse(quality['paragraphReady'])
        self.assertEqual(recommendation['strategies'], ['RECURSIVE'])

    def test_medium_short_fragments_are_not_semantic_ready(self):
        quality = assess_quality([block(1, '短文本'), block(2, '另一段短文本'), block(3, '第三段短文本')])
        recommendation = recommend_child_strategies({'childStrategies': [], 'llmEnabled': False}, quality)
        self.assertEqual(quality['level'], 'MEDIUM')
        self.assertFalse(quality['paragraphReady'])
        self.assertEqual(recommendation['strategies'], ['RECURSIVE'])

    def test_high_quality_paragraphs_choose_semantic_recursive(self):
        text = '这是一个包含清晰语义边界的较长段落。' * 8
        quality = assess_quality([block(index, text) for index in range(1, 5)])
        recommendation = recommend_child_strategies({'childStrategies': [], 'llmEnabled': False}, quality)
        self.assertEqual(quality['level'], 'HIGH')
        self.assertTrue(quality['paragraphReady'])
        self.assertEqual(recommendation['strategies'], ['SEMANTIC', 'RECURSIVE'])

    def test_low_quality_can_recommend_llm_only_when_available(self):
        quality = assess_quality([block(1, 'OCR碎片', kind='noise')])
        config = {'childStrategies': [], 'llmEnabled': True, 'recommendLlmWhenLowQuality': True}
        self.assertEqual(recommend_child_strategies(config, quality)['strategies'], ['RECURSIVE'])
        self.assertEqual(recommend_child_strategies(config, quality, llm_available=True)['strategies'], ['LLM', 'RECURSIVE'])

    def test_same_input_is_stable(self):
        values = [block(1, '稳定段落。' * 40), block(2, '另一个稳定段落。' * 40)]
        self.assertEqual(assess_quality(values), assess_quality(values))
