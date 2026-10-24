# Added to the pinned sherpa-onnx tree by build-ensemble-wasm.sh.
add_executable(pageborne-speech pageborne-speech.cc)
target_include_directories(pageborne-speech PRIVATE ${CMAKE_SOURCE_DIR})
target_link_libraries(pageborne-speech sherpa-onnx-core)
set_target_properties(pageborne-speech PROPERTIES SUFFIX ".mjs")
target_link_options(pageborne-speech PRIVATE
  "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sENVIRONMENT=worker,node"
  "-sALLOW_MEMORY_GROWTH=1" "-sINITIAL_MEMORY=67108864" "-sMAXIMUM_MEMORY=1073741824"
  "-sSTACK_SIZE=1048576" "-sFILESYSTEM=1" "-sFORCE_FILESYSTEM=1"
  "-sEXPORTED_RUNTIME_METHODS=['ccall','FS','UTF8ToString','HEAPU8','HEAPF32']"
  "-sEXPORTED_FUNCTIONS=['_malloc','_free','_pb_init','_pb_zip_start','_pb_zip_accept','_pb_zip_ready','_pb_zip_decode','_pb_zip_result','_pb_zip_end','_pb_ctc_run','_pb_ctc_frames','_pb_ctc_vocab','_pb_ctc_release','_pb_close']")
