"""Research-only confidence telemetry; greedy decoder unchanged, pre-bias softmax."""
from pathlib import Path
p=Path('.state/ensemble/moonshine-source/core/transcriber.cpp');s=p.read_text()
if 'trial_probabilities' in s:
 print('Confidence telemetry already installed')
 raise SystemExit(0)
s=s.replace('  std::vector<int64_t> tokens;\n\n  ContextBiaser', '  std::vector<int64_t> tokens;\n  std::vector<double> trial_probabilities;\n\n  ContextBiaser')
s=s.replace('      if (biaser != nullptr) {\n        biaser->apply(logits.data(), config.vocab_size);', '      const std::vector<float> trial_raw_logits = logits;\n      if (biaser != nullptr) {\n        biaser->apply(logits.data(), config.vocab_size);')
s=s.replace('      tokens.push_back(next_token);', '''      double trial_max = *std::max_element(trial_raw_logits.begin(), trial_raw_logits.end());
      double trial_sum = 0;
      for (float value : trial_raw_logits) trial_sum += std::exp(value - trial_max);
      trial_probabilities.push_back(std::exp(trial_raw_logits[next_token] - trial_max) / trial_sum);
      tokens.push_back(next_token);''')
s=s.replace('  std::string text = this->streaming_model->tokens_to_text(tokens);', '''  std::string text = this->streaming_model->tokens_to_text(tokens);
  if (const char *path = std::getenv("ENSEMBLE_CONFIDENCE_LOG")) {
    if (FILE *out = std::fopen(path, "a")) {
      auto hex = [&](const std::string &value) { for (unsigned char c : value) std::fprintf(out, "%02x", c); };
      std::fprintf(out, "BEGIN\\t"); hex(text); std::fprintf(out, "\\n");
      for (size_t i = 0; i < trial_probabilities.size(); ++i) {
        std::vector<int64_t> prefix(tokens.begin(), tokens.begin() + i + 2);
        std::fprintf(out, "%.9g\\t", trial_probabilities[i]);
        hex(this->streaming_model->tokens_to_text(prefix)); std::fprintf(out, "\\n");
      }
      std::fprintf(out, "END\\n"); std::fclose(out);
    }
  }''')
assert 'trial_probabilities.push_back' in s
p.write_text(s)
