// Thin adapter over sherpa-onnx and kaldi-native-fbank. No model weights.
#include <cmath>
#include <memory>
#include <string>
#include <vector>
#include "kaldi-native-fbank/csrc/online-feature.h"
#include "sherpa-onnx/csrc/online-recognizer.h"
#include "sherpa-onnx/csrc/offline-nemo-enc-dec-ctc-model.h"

namespace {
std::unique_ptr<sherpa_onnx::OnlineRecognizer> zip;
std::unique_ptr<sherpa_onnx::OnlineStream> stream;
std::unique_ptr<sherpa_onnx::OfflineNemoEncDecCtcModel> ctc;
std::vector<Ort::Value> output;
std::string result;
}

extern "C" {
int pb_init(int kind) {
  if (kind == 0) {
    sherpa_onnx::OnlineRecognizerConfig config;
    config.model_config.transducer.encoder = "/models/encoder.onnx";
    config.model_config.transducer.decoder = "/models/decoder.onnx";
    config.model_config.transducer.joiner = "/models/joiner.onnx";
    config.model_config.tokens = "/models/tokens.txt";
    config.model_config.modeling_unit = "bpe";
    config.model_config.bpe_vocab = "/models/bpe.vocab";
    config.model_config.num_threads = 1;
    config.decoding_method = "modified_beam_search";
    config.max_active_paths = 4;
    config.temperature_scale = 1.0;
    config.enable_endpoint = false;
    if (!config.Validate()) return 0;
    zip = std::make_unique<sherpa_onnx::OnlineRecognizer>(config);
  } else {
    sherpa_onnx::OfflineModelConfig config;
    config.nemo_ctc.model = "/models/model.onnx";
    config.num_threads = 1;
    ctc = std::make_unique<sherpa_onnx::OfflineNemoEncDecCtcModel>(config);
  }
  return 1;
}
void pb_zip_start(const char *hotwords) { stream = zip->CreateStream(hotwords); }
void pb_zip_accept(const float *samples, int count) { stream->AcceptWaveform(16000, samples, count); }
int pb_zip_ready() { return zip->IsReady(stream.get()); }
void pb_zip_decode() { zip->DecodeStream(stream.get()); }
const char *pb_zip_result() { result = zip->GetResult(stream.get()).AsJsonString(); return result.c_str(); }
void pb_zip_end() { stream->InputFinished(); }
float *pb_ctc_run(const float *samples, int count) {
  knf::FbankOptions opts;
  opts.frame_opts.dither = 0;
  opts.frame_opts.snip_edges = false;
  opts.frame_opts.samp_freq = 16000;
  opts.mel_opts.num_bins = 80;
  knf::OnlineFbank fbank(opts);
  std::vector<float> scaled(count);
  for (int i = 0; i < count; ++i) scaled[i] = samples[i] * 32768.0f;
  fbank.AcceptWaveform(16000, scaled.data(), count);
  fbank.InputFinished();
  const int64_t frames = fbank.NumFramesReady();
  const int64_t shape[] = {1, frames, 80}, length_shape[] = {1};
  auto features = Ort::Value::CreateTensor<float>(ctc->Allocator(), shape, 3);
  auto lengths = Ort::Value::CreateTensor<int64_t>(ctc->Allocator(), length_shape, 1);
  lengths.GetTensorMutableData<int64_t>()[0] = frames;
  float *data = features.GetTensorMutableData<float>();
  for (int t = 0; t < frames; ++t) std::copy_n(fbank.GetFrame(t), 80, data + t * 80);
  // Match the benchmark's population standard deviation, not a sample estimate.
  for (int c = 0; c < 80; ++c) {
    double mean = 0, variance = 0;
    for (int t = 0; t < frames; ++t) mean += data[t * 80 + c];
    mean /= frames;
    for (int t = 0; t < frames; ++t) variance += std::pow(data[t * 80 + c] - mean, 2);
    const double scale = std::sqrt(variance / frames) + 1e-5;
    for (int t = 0; t < frames; ++t) data[t * 80 + c] = (data[t * 80 + c] - mean) / scale;
  }
  output = ctc->Forward(std::move(features), std::move(lengths));
  return output[0].GetTensorMutableData<float>();
}
int pb_ctc_frames() { return output[0].GetTensorTypeAndShapeInfo().GetShape()[1]; }
int pb_ctc_vocab() { return ctc->VocabSize(); }
void pb_ctc_release() { output.clear(); }
void pb_close() { output.clear(); stream.reset(); zip.reset(); ctc.reset(); }
}
