add_executable(punctuation-trial punctuation-trial.cc)
target_include_directories(punctuation-trial PRIVATE ${CMAKE_SOURCE_DIR})
target_link_libraries(punctuation-trial sherpa-onnx-core)
set_target_properties(punctuation-trial PROPERTIES SUFFIX ".mjs")
target_link_options(punctuation-trial PRIVATE
  "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sENVIRONMENT=worker,node"
  "-sALLOW_MEMORY_GROWTH=1" "-sINITIAL_MEMORY=33554432" "-sMAXIMUM_MEMORY=536870912"
  "-sSTACK_SIZE=1048576" "-sFILESYSTEM=1" "-sFORCE_FILESYSTEM=1"
  "-sEXPORTED_RUNTIME_METHODS=['ccall','FS','UTF8ToString','HEAPU8']"
  "-sEXPORTED_FUNCTIONS=['_malloc','_free','_punct_init','_punct_run','_punct_close']")
