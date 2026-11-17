(function ($) {
	$(function () {
		$('.cwsv-color').wpColorPicker();
		var frame;
		$('#cwsv-pick').on('click', function (e) {
			e.preventDefault();
			if (!frame) {
				frame = wp.media({ title: 'Choose a logo', library: { type: 'image' }, multiple: false, button: { text: 'Use this logo' } });
				frame.on('select', function () {
					var a = frame.state().get('selection').first().toJSON();
					$('#cwsv-logo-id').val(a.id);
					$('#cwsv-logo-url').val('');
					$('#cwsv-logo-prev').attr('src', (a.sizes && a.sizes.medium ? a.sizes.medium.url : a.url));
				});
			}
			frame.open();
		});
		$('#cwsv-logo-url').on('input', function () { $('#cwsv-logo-id').val(0); if (this.value) $('#cwsv-logo-prev').attr('src', this.value); });
		$('#cwsv-tech').on('click', function () { $('.cwsv-top[data-tech="1"]:not(:disabled)').prop('checked', true); });
		$('#cwsv-none').on('click', function () { $('#cwsv input[type=checkbox].cwsv-top, #cwsv input[type=checkbox].cwsv-sub').prop('checked', false); });
	});
})(jQuery);
