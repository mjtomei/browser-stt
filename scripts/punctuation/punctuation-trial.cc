// Experimental standalone adapter; never linked into the shipped ASR runtime.
#include <memory>
#include <string>
#include "sherpa-onnx/csrc/online-punctuation.h"
namespace {
std::unique_ptr<sherpa_onnx::OnlinePunctuation> model;
std::string result;
}
extern "C" {
int punct_init() {
  sherpa_onnx::OnlinePunctuationConfig config;
  config.model.cnn_bilstm = "/model.onnx";
  config.model.bpe_vocab = "/bpe.vocab";
  config.model.num_threads = 1;
  if (!config.Validate()) return 0;
  model = std::make_unique<sherpa_onnx::OnlinePunctuation>(config);
  return 1;
}
const char *punct_run(const char *text) {
  result = model->AddPunctuationWithCase(text);
  return result.c_str();
}
void punct_close() {
  model.reset();
  result.clear();
}
}
