#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Exportation et publication",
  description: "Comment transformer des notes en productions professionnelles : exportation d'une seule note en PDF, HTML ou Pandoc, PDF/A et PDF/UA accessibles, et exportation d'une collection fusionnée (livre) ou d'un site statique.",
  tags: ("documentation",),
)

= Exportation et publication

== Transformer vos notes en travail fini

Comment transformerez-vous vos notes et votre texte en une production que vous pouvez distribuer ? Prenez les notes que vous avez ébauchées et transformez-les en productions bien conçues et professionnelles que vous pouvez remettre à un lecteur, à un éditeur, à un dépôt ou au Web. InkyCap exporte une seule note à elle seule, mais il peut aussi fusionner toute une #wikilink("2 - Collections", display: "collection") de notes en un seul document soigné (un livre) ou en pages web pour un site.

Vous n'avez besoin de rien connaître de Typst ni de la mise en page pour utiliser cette fonctionnalité. Vous choisissez un format, sélectionnez quelques options, et InkyCap produit le fichier.

Il y a deux points de départ, selon ce que vous voulez exporter :

+ *Une note* → la boîte de dialogue *Exporter*.
+ *Une collection entière* (plusieurs notes à la fois, ou fusionnées en livre) → le menu *Exporter* dans la table de la collection. Voir #wikilink("2 - Collections").
\

== Exporter une seule note

=== Ouvrir la boîte de dialogue Exporter

Vous pouvez ouvrir la boîte de dialogue de plusieurs façons :

- Depuis le menu de débordement de la note, choisissez *Exporter...*.
- Depuis la palette de commandes, lancez *Exporter la note en PDF* (cela ouvre la boîte de dialogue déjà réglée sur PDF).
- Depuis la palette de commandes, lancez *Exporter un fichier .typ autonome* (cela ouvre la boîte de dialogue déjà réglée sur le format portable `.typ`).
- Depuis la table d'une collection, faites un clic droit sur une ligne et choisissez *Exporter la note...*. La boîte de dialogue applique alors le template Typst et le style de bibliographie de la collection à cette seule note, et l'indique en haut.

La boîte de dialogue est une petite fenêtre au centre de l'écran. Appuyez sur *Échap*, cliquez sur l'arrière-plan, cliquez sur le *×* dans son coin, ou utilisez le bouton *Annuler* pour la fermer (le bouton affiche *Fermer* une fois une exportation terminée). Lorsque vous êtes prêt, cliquez sur *Exporter*.

=== Choisir un format

Le menu déroulant *Format* est divisé en deux groupes.

Le groupe *Typst* ne nécessite aucun logiciel supplémentaire. InkyCap les produit à lui seul :

- *PDF (.pdf)* est le format par défaut. Un document fini, prêt à imprimer.
- *Autonome (.typ)* est une copie portable de la note qui inclut tout ce dont elle a besoin pour être ouverte dans un autre outil fondé sur Typst (le package de la boîte de notes et toute image sont copiés à côté).
- *HTML (.html)* est une page web autonome. Toute image, vidéo ou audio que votre note référence est copiée à côté de la page pour qu'elle fonctionne partout (par exemple, copiée sur un serveur web).
- *Markdown (.md)* est une version Markdown en texte brut de la note.

Le groupe *Via Pandoc* produit *OpenDocument (.odt)*, *LaTeX (.tex)*, *Word (.docx)* et *PDF avec propriétés (.pdf)*. Ceux-ci nécessitent l'installation de l'outil gratuit Pandoc sur votre système (voir #link(<pandoc>)[Travailler avec Pandoc] ci-dessous).

=== Options que vous pourriez voir

Selon le format que vous choisissez, quelques options apparaissent :

- *Métadonnées de la note* (formats PDF, HTML et Pandoc). Choisissez *Exclure les métadonnées* (le défaut) pour garder les #wikilink("6 - Propriétés des notes", display: "propriétés") de votre note hors du fichier, ou *Inclure comme propriétés du document* pour enregistrer le titre, l'auteur, la date et les mots-clés comme les propriétés du document lui-même (de sorte qu'ils apparaissent dans les métadonnées d'un PDF, l'élément `<head>` d'une page web, ou les Propriétés du fichier d'un traitement de texte).
- *Inclure la bibliographie dans la sortie* (PDF et HTML seulement). Activé par défaut. Lorsque c'est activé, votre liste de références apparaît à la fin. Lorsque c'est désactivé, les citations se résolvent quand même normalement, mais la bibliographie rendue est laissée de côté. Voir #wikilink("7 - Citations et bibliographie").
- *Extraire les figures avec l'exportation* (tous les formats). Lorsque c'est activé, InkyCap écrit aussi un dossier des images de vos figures à côté de l'exportation.
- *Retirer les liens internes (liens wiki)* (HTML seulement) supprime les liens internes à la note pour que la page se lise comme une prose autonome.
- *Préserver le balisage Typst non convertible (en blocs de code)* (Markdown seulement). Activé par défaut. Markdown ne peut pas représenter chaque construction Typst, alors tout ce qu'il ne peut pas traduire est enveloppé dans un bloc de code plutôt que perdu. Désactivez-le pour un fichier plus propre si vous ne craignez pas de laisser tomber ces parties.

== Des PDF professionnels et accessibles

Le format PDF offre un menu déroulant *Standard PDF*. C'est là que vous choisissez à quel point le fichier doit être rigoureux et accessible :

- *Standard (PDF 1.7)* est le défaut. Un PDF normal, largement compatible.
- *PDF/A-4 (archivage)* est un format d'archivage à long terme qui convient aux dépôts institutionnels et aux thèses qui doivent rester lisibles pendant des décennies.
- *PDF/UA-1 (accessible)* signifie Accessibilité universelle. Produit un PDF entièrement balisé et structuré que les technologies d'assistance comme les lecteurs d'écran peuvent parcourir.
- *PDF/A-2a + PDF/UA-1 (archivage + accessible)* vous donne les deux dans un seul fichier : la conservation à long terme avec le balisage d'accessibilité complet.

Pour les trois normes strictes, InkyCap ajoute automatiquement la date du jour comme date du document si votre note n'en définit pas déjà une (ces formats exigent une date).

#callout("important")[ *PDF/UA-1 (seul ou combiné à PDF/A-2a) refusera d'exporter tant que votre note n'est pas réellement accessible.* Avant de produire le fichier, InkyCap vérifie toute la note et, s'il y a des problèmes, s'arrête et les énumère *tous* en même temps avec les numéros de ligne pour que vous puissiez les corriger d'un seul coup. Les deux choses sur lesquelles il insiste :

- *Chaque image a besoin d'un texte de remplacement* (une courte description de ce que l'image montre, pour qu'un lecteur d'écran puisse le transmettre).
- *Les titres ne doivent pas sauter de niveaux*. Passez d'une section à une sous-section sans sauter un niveau (pas de `=` directement à `===`). ]

#callout("tip", title: "Pour les utilisateurs de Typst")[ L'exigence de texte de remplacement correspond à l'argument `alt:` de chaque `#image(...)`, et la règle des titres veut une imbrication consécutive `=` / `==` / `===`. La vérification préalable (`check_pdf_standard_requirements`) bloque l'exportation et agrège chaque ligne fautive en une seule erreur exploitable ; il n'y a délibérément aucune valeur de repli `alt:` silencieuse. Les normes correspondent à `PdfStandard::A_4` et `PdfStandard::Ua_1` de `typst-pdf` ; le préréglage combiné demande `A_2a` avec `Ua_1`. PDF/A-4 repose sur PDF 2.0 tandis que PDF/UA-1 est lié à PDF 1.7, alors ces deux-là ne peuvent pas être jumelés, ce qui explique pourquoi la combinaison utilise PDF/A-2a. ]

== Travailler avec Pandoc <pandoc>

Les formats *Via Pandoc* (OpenDocument, LaTeX, Word et PDF-avec-propriétés) reposent sur #link("https://pandoc.org/")[Pandoc], un outil gratuit et à code source ouvert de conversion de documents que vous installez séparément.

Si InkyCap ne trouve pas Pandoc, la boîte de dialogue affiche *Pandoc est introuvable. Installez-le ou définissez un chemin personnalisé dans les paramètres.* et le bouton Exporter est désactivé jusqu'à ce que vous régliez la situation. Vous pouvez indiquer à InkyCap votre installation de Pandoc dans les #wikilink("2 - Paramètres"), sous l'onglet *Importation/Exportation et sauvegarde*, dans la section *Exportation* : le champ *Chemin de Pandoc* reçoit l'emplacement de votre programme Pandoc, ou laissez-le vide pour le détecter automatiquement. Une ligne d'état en direct vous dit s'il a été trouvé.

#callout("note")[ Lorsqu'il utilise Pandoc, InkyCap rend d'abord votre note en HTML, puis laisse Pandoc convertir à partir de là. Cela garde les fonctionnalités de la boîte de notes opérationnelles dans la sortie. Il en résulte que certaines mathématiques complexes peuvent paraître imparfaites par ce chemin, par rapport à une exportation PDF native. Si votre travail est fortement mathématique, préférez le format natif *PDF (.pdf)*. ]

L'option *PDF avec propriétés (.pdf)* nécessite en plus un moteur PDF. InkyCap en cherche un automatiquement et accepte l'un ou l'autre de `typst`, `xelatex`, `lualatex`, `pdflatex` ou `tectonic`. Si aucun n'est disponible, il vous le dit et vous renvoie à l'exportation PDF native, qui n'a pas besoin d'outils supplémentaires.

== Le suivi des modifications dans vos exportations

Si votre note porte des suggestions de modifications suivies ou des notes de révision issues d'un travail avec un collaborateur, un menu déroulant *Marquage de révision* apparaît pour que vous puissiez décider comment ces marques se présentent :

- *Conserver les modifications suivies* (le défaut). Les suggestions et les notes de révision apparaissent comme des marques visibles de modifications suivies, tout comme vous les voyez pendant l'édition.
- *Accepter toutes les modifications* applique chaque modification suggérée et retire les notes de révision, vous donnant une copie publiée propre.
- *Rejeter toutes les modifications* écarte les modifications suggérées (le texte original reste) et retire les notes de révision.

Conserver est le défaut partout, et ce contrôle ne s'affiche que pour une seule note lorsque cette note contient réellement du marquage de révision. Voir #wikilink("1 - Collaboration").

== Exporter une collection entière

Une #wikilink("2 - Collections", display: "collection") rassemble plusieurs notes apparentées, et vous pouvez les publier toutes d'un coup. Ouvrez la table de la collection, puis cliquez sur *Exporter* dans sa barre d'outils. Le menu offre :

- *Tableau en CSV* / *Tableau en TSV* enregistre la grille de notes de la collection sous forme de fichier de tableur.
- *Collection en fichiers PDF* écrit un PDF par note, dans un dossier que vous choisissez. Si une seule note ne compile pas, InkyCap le signale mais poursuit avec le reste.
- *Collection fusionnée en un seul PDF (livre)* combine chaque note en un seul document bien structuré (voir ci-dessous).
- *Collection en fichiers HTML* publie la collection comme un petit site web (voir ci-dessous).
- *Collection en fichiers Markdown* écrit un fichier Markdown par note.

Le menu porte aussi ses propres menus déroulants *Standard PDF* et *Marquage de révision*, avec les mêmes choix décrits ci-dessus, de sorte que tout le lot suit votre décision. L'ordre des notes dans chaque exportation de collection suit le tri actuel ou l'ordre manuel de la collection.

== Fusionner une collection en un « livre »

*Collection fusionnée en un seul PDF (livre)* est la façon de produire un document professionnel de longue haleine (une thèse, un rapport, un ouvrage collectif) à partir de plusieurs notes. Le résultat peut inclure une page de titre, un résumé, une table des matières, vos chapitres dans l'ordre, et une seule bibliographie.

Vous configurez cela dans l'onglet *Métadonnées et structure du livre* de la collection, dans le panneau de droite, qui s'enregistre automatiquement à mesure que vous le modifiez. Choix clés :

- *Titre*, *Sous-titre*, *Date* et *Résumé* pour le début du livre.
- *Contributeurs* est une liste de toutes les personnes qui y ont travaillé (couverte ci-dessous).
- *Page de titre* → *Inclure* est activé par défaut. Si vous avez choisi un template Typst pour la collection, un rappel apparaît ici : lorsque le template génère sa propre page de titre, laissez cette case décochée pour ne pas en obtenir deux.
- *Table des matières* → *Inclure*, avec un réglage de *Profondeur* et un menu déroulant *Emplacement* :
  - *Au début* (défaut) la place dans les pages liminaires, avant le premier chapitre.
  - *À la fin* la place après le dernier chapitre, avant la bibliographie.
  - *Après {chapter}* la place juste après un chapitre précis que vous nommez.
- *Titre de chapitre* contrôle si InkyCap fournit le titre supérieur de chaque chapitre à partir du titre de la note, toujours, jamais, ou seulement lorsqu'une note n'a pas le sien.
- *Liens wiki* → *Résolution* décide ce que deviennent les liens entre vos notes dans le livre : *Résoudre vers les chapitres du livre* les transforme en sauts vers le bon chapitre, *Lier aux fichiers sources (comme à la compilation d'une note seule)* les garde pointés vers les fichiers de notes, et *Texte brut seulement (retirer les liens)* ne laisse que les mots.
- *Numérotation des pages* → *Style* définit le schéma du livre fusionné. Il y en a quatre : *Romains (i, ii, iii…) puis arabes à partir du chapitre 1* ; *Pages liminaires non numérotées, les chapitres commencent à 1* ; *Chiffres arabes à partir de la page 1* ; et *Chiffres arabes commençant à une page précise*, qui ajoute un champ *Commencer à la page*. Ce choix décide seulement où s'appliquent la numérotation romaine et la numérotation arabe ; le format des nombres lui-même, ainsi que la numérotation des chapitres et des titres, proviennent de l'onglet *Substitutions de style*.

=== Où va la bibliographie

Le menu déroulant *Bibliographie* décide à la fois comment les listes de références sont construites et où elles vont :

- *Unifiée (une liste à la fin)*, le défaut, construit une seule liste de références consolidée à partir du fichier de bibliographie de la collection et la place à la fin. La bibliographie propre à chaque note (si elle en a une) est ignorée au profit de la consolidée. \
- *Par chapitre* termine chaque chapitre par sa propre liste de références, construite à partir du fichier de bibliographie de la collection et limitée aux sources que ce chapitre cite. La liste de chaque chapitre est numérotée indépendamment, ce qui convient à un ouvrage collectif où chaque auteur est crédité de ses propres sources. Ici aussi, la bibliographie propre à chaque note est ignorée.
- *Sur place (placée par l'auteur)* garde la bibliographie de chaque note exactement là où son auteur l'a placée. Un livre peut en contenir plusieurs, alors c'est le choix à faire lorsque vous avez placé à la main des listes de références par catégorie ou par section.

Voir #wikilink("7 - Citations et bibliographie") pour savoir comment fonctionnent les listes de références et les styles de citation.

=== Rendre crédit : la signature et les contributeurs

La liste des *Contributeurs* est la façon dont un livre multi-auteurs obtient une signature et une page de crédits en bonne et due forme. Pour chaque personne, vous pouvez enregistrer :

- son *nom*,
- un *rôle bibliographique*, dont la valeur par défaut est Auteur et qui peut être Éditeur, Traducteur, Illustrateur, et ainsi de suite, et
- un nombre quelconque de *rôles #link("https://casrai.org/credit")[CRediT]* (les quatorze catégories de contribution standard utilisées dans l'édition savante : Conceptualisation, Méthodologie, Rédaction (ébauche originale), Rédaction (révision et édition), et le reste).

À partir de cette liste, InkyCap construit la *signature de la page de titre* (groupée par rôle), enregistre les auteurs dans les métadonnées du document, et (lorsqu'au moins une personne a un rôle CRediT) ajoute un *énoncé de contributions* facultatif sur sa propre page. Vous pouvez désactiver cet énoncé avec l'option *Inclure la déclaration des contributions CRediT dans l'exportation du livre* ; la signature apparaît dans tous les cas.

=== Lorsqu'une note ne compile pas

Si certaines notes contiennent des erreurs, l'exportation du livre se met en pause avec une boîte de dialogue *Certaines notes comportent des erreurs* qui les énumère. Vous pouvez choisir *Continuer (exclure)* pour laisser ces notes de côté et produire le reste du livre, ou *Arrêter et corriger* pour revenir en arrière et les réparer d'abord. (Un problème dans les pages liminaires du livre lui-même est un arrêt complet, puisqu'il n'y aurait rien à construire.)

Le fichier fini porte le nom du titre de votre livre et est enregistré là où vous choisissez.

#callout("tip", title: "Pour les utilisateurs de Typst")[ Les notes sont insérées en ligne dans un seul document synthétique ancré à la racine de la boîte de notes ; par note, l'importation du package, le `#note(...)` initial et (dans les modes Unifiée et Par chapitre) tout `#bibliography(...)` sont retirés, et les chemins d'image relatifs sont rebasés. Une analyse de collision d'étiquettes bloque l'exportation si vos propres étiquettes sont dupliquées entre les notes (les étiquettes internes `<inkycap-*>` sont exemptées). La signature et l'énoncé CRediT sont rendus par `#contributors-byline(...)` et `#credit-statement(...)` dans le package de la boîte de notes, alors la mise en forme vit dans du Typst modifiable plutôt que dans une sortie codée en dur. ]

== Publier une collection comme site web

*Collection en fichiers HTML* transforme votre collection en un petit site web autonome (un ensemble de pages web interactives que vous pouvez héberger n'importe où). InkyCap produit :

- une page web par note,
- une *page d'index* qui énumère et relie chaque page, et
- une feuille de style avec un design épuré en mode clair et sombre qui suit la préférence du système du lecteur.

Les liens wiki entre les notes de la collection deviennent des liens ordinaires cliquables entre les pages, et toute image, vidéo ou audio est copiée dans le site pour que chaque page tienne d'elle-même. Si une note ne compile pas, elle est ignorée et signalée, pour que vous puissiez la corriger et exporter de nouveau. Une page publiée n'est incluse que lorsqu'elle se rend complètement.

== Conception, style et personnalisation

Lorsque vous exportez une collection, InkyCap superpose automatiquement votre mise en style pour que le résultat ait l'air délibéré et cohérent : d'abord vos valeurs par défaut à l'échelle de l'application, puis les *Substitutions de style* propres à la collection (taille du papier, marges, polices, espacement, numérotation des pages et des titres), puis tout template Typst que vous avez choisi pour la collection, et enfin votre propre Typst personnalisé. Vous trouvez ces réglages dans les onglets du panneau de droite de la collection ; voir #wikilink("2 - Collections") et #wikilink("2 - Paramètres").

- Pour *choisir un template Typst pour votre collection*, ouvrez l'onglet *Caractéristiques* de la collection et choisissez-en un dans le menu déroulant *Template Typst*. Il énumère les templates que vous avez installés, plus *Aucun* et *Personnalisé…* (qui vous laisse saisir vous-même une spécification de package ou un chemin de la boîte de notes). Vous devez d'abord installer le template (voir #wikilink("3 - Scaffolds, Templates et Packages")).
- Choisir un template ne fait que le rendre disponible. Pour l'appliquer réellement, cliquez sur *Configurer le template…*, qui apparaît une fois un template choisi. Cela ouvre l'éditeur de Typst personnalisé de la collection avec la configuration propre au template déjà remplie, prête à recevoir votre titre, vos auteurs et tout ce que le template demande.
- L'onglet *Substitutions de style* se termine par une rangée *Typst personnalisé*. Utilisez *Ajouter…* (ou *Modifier…* une fois qu'il y a quelque chose) pour écrire votre propre style Typst, qui est appliqué en dernier et l'emporte donc sur tout ce qui précède. Le bouton *Insérer la configuration du template* de l'éditeur remplit pour vous la configuration du template choisi, la même chose que fait *Configurer le template…*.

#callout("note")[ Lorsque vous choisissez un template, les contrôles de l'onglet *Substitutions de style* sont verrouillés et un avis explique pourquoi : le template contrôle la mise en page, alors ces substitutions n'auraient aucun effet. Ajustez plutôt la mise en page à travers la configuration propre au template, dans la rangée *Typst personnalisé*. ]



== Pages connexes

- #wikilink("2 - Collections") : rassembler des notes pour les publier ensemble.
- #wikilink("7 - Citations et bibliographie") : les listes de références et les styles de citation dans votre sortie.
- #wikilink("1 - Collaboration") : le suivi des modifications et leur affichage lors de l'exportation.
- #wikilink("2 - Paramètres") : où définir le chemin de Pandoc et les autres préférences d'exportation.
