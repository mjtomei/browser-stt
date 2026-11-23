"""Reproduce the Mini WebGPU graph from the pinned upstream ONNX files.

Requires Python, onnx 1.20+ and numpy. Run with the downloaded model directory.
Weights remain packed and unchanged. Expand(float zero point) is unsupported
by WebGPU MatMulNBits: use its integer midpoint and an explicit correction.
For row-constant scales/zero points, sum(A * ((q-z)*s)) equals
sum(A * ((q-midpoint)*s)) + sum(A) * ((midpoint-z)*s).
Floating-point association differs; browser/native transcript parity is tested
separately. This is a graph adaptation, not model retraining or requantization.
"""
import hashlib
import json
from pathlib import Path
import sys
import numpy as np
import onnx
from onnx import helper, numpy_helper

root = Path(sys.argv[1])
vendor = Path(__file__).resolve().parent.parent / 'vendor/stt'
manifest = json.loads((vendor / 'fluid-mini.json').read_text())
for name in ['encoder.onnx', 'encoder.onnx.data']:
    entry = next(f for f in manifest['files'] if f['file'] == name)
    with (root / name).open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == entry['sha256'], name
model = onnx.load(root / 'encoder.onnx', load_external_data=False)
nodes = {output: node for node in model.graph.node for output in node.output}
initial = {tensor.name: tensor for tensor in model.graph.initializer}
new, added, count = [], [], 0
axes = 'pb_sum_axes'
added.append(numpy_helper.from_array(np.array([-1], np.int64), axes))
for node in model.graph.node:
    if node.op_type != 'MatMulNBits':
        new.append(node)
        continue
    attrs = {a.name: helper.get_attribute_value(a) for a in node.attribute}
    assert attrs['bits'] in [2, 4] and len(node.input) == 4
    scale, zero = nodes[node.input[2]], nodes[node.input[3]]
    assert scale.op_type == zero.op_type == 'Expand'
    s = numpy_helper.to_array(initial[scale.input[0]], base_dir=str(root))
    z = numpy_helper.to_array(initial[zero.input[0]], base_dir=str(root))
    assert s.shape == z.shape == (attrs['N'], 1)
    expected = [attrs['N'], (attrs['K'] + attrs['block_size'] - 1) // attrs['block_size']]
    for expansion in [scale, zero]:
        assert numpy_helper.to_array(initial[expansion.input[1]], base_dir=str(root)).tolist() == expected
    assert np.isfinite(s).all() and np.isfinite(z).all()
    delta = (((2 ** (attrs['bits'] - 1)) - z) * s).reshape(1, attrs['N']).astype(np.float32)
    prefix = f'pb_nbits_{count}'
    added.append(numpy_helper.from_array(delta, prefix + '_delta'))
    a, output = node.input[0], node.output[0]
    node.input.pop()
    node.output[0] = prefix + '_quantized'
    new.extend([node,
        helper.make_node('ReduceSum', [a, axes], [prefix + '_sum'], name=prefix + '_reduce', keepdims=1),
        helper.make_node('Mul', [prefix + '_sum', prefix + '_delta'], [prefix + '_correction'], name=prefix + '_mul'),
        helper.make_node('Add', [prefix + '_quantized', prefix + '_correction'], [output], name=prefix + '_add')])
    count += 1
assert count == 264
model.graph.ClearField('node')
model.graph.node.extend(new)
model.graph.initializer.extend(added)
output = vendor / 'fluid-mini-encoder-webgpu.onnx'
encoded = model.SerializeToString()
assert hashlib.sha256(encoded).hexdigest() == 'ed84438023e7954591b29780bd1f8b8d13b972018527271f83d4da2596ac0935'
output.write_bytes(encoded)
print(f'{count} quantized operations adapted; {len(encoded)} graph bytes; external weights unchanged.')
