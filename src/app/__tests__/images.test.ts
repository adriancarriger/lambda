import {
  imageUrl,
  podImageSrc,
  splitImages,
  withImage,
  withWords,
  withoutImage,
  wordsOf,
} from '../shared/images';

const SHOT = '/home/leslie/.pods/_uploads/img_m1x2_ab12cd.png';

describe('images in a message', () => {
  it('splits a message into its words and the images it carries', () => {
    expect(
      splitImages(`The lot is flooded\n[Image: ${SHOT}]\nsee above`)
    ).toEqual({ text: 'The lot is flooded\nsee above', images: [SHOT] });
  });

  it('adds an image on its own line, and takes it out again', () => {
    const draft = withImage('Look at this  ', SHOT);

    expect(draft).toBe(`Look at this\n[Image: ${SHOT}]\n`);
    expect(withImage('', SHOT)).toBe(`[Image: ${SHOT}]\n`);
    expect(withoutImage(draft, SHOT)).toBe('Look at this\n');
  });

  it('serves only its own uploads', () => {
    expect(imageUrl(SHOT)).toBe('/api/uploads/img_m1x2_ab12cd.png');
    expect(imageUrl('/etc/passwd')).toBeNull();
    expect(imageUrl('/tmp/PAWNEE-74.png')).toBeNull();
  });
});

describe('the message box shows words, not image lines', () => {
  it('shows only the words, as typed (trailing space and new line kept)', () => {
    expect(wordsOf(withImage('The lot is flooded ', SHOT))).toBe(
      'The lot is flooded'
    );
    expect(wordsOf(`Ron says \n[Image: ${SHOT}]`)).toBe('Ron says ');
  });

  it('typing keeps the attached images, after the words', () => {
    const draft = withImage('', SHOT);
    const typed = withWords(draft, 'Leslie, look');

    expect(splitImages(typed)).toEqual({
      text: 'Leslie, look',
      images: [SHOT],
    });
    expect(wordsOf(typed)).toBe('Leslie, look');
  });

  it('a draft without images is just the words', () => {
    expect(withWords('old', 'Ann Perkins')).toBe('Ann Perkins');
  });
});

describe('podImageSrc', () => {
  it("serves a pod's own picture linked by its path on disk", () => {
    expect(
      podImageSrc(
        '/home/a/work/pawnee/.pods/live-home-3557/shots/home-desktop.png'
      )
    ).toBe('/api/pod-file/live-home-3557/shots/home-desktop.png');
  });

  it('leaves any other picture as it is', () => {
    expect(podImageSrc('https://example.com/a.png')).toBe(
      'https://example.com/a.png'
    );
    expect(podImageSrc('/etc/passwd')).toBe('/etc/passwd');
    expect(podImageSrc('/api/uploads/img_a_b.png')).toBe(
      '/api/uploads/img_a_b.png'
    );
  });
});
